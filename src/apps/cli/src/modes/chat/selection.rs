enum SessionUpdateApplyOutcome {
    SessionUpdateFailed(String),
    OutcomeUnknown(String),
    Applied,
}

enum SessionUpdatePollOutcome {
    NoChange,
    Redraw,
    ExitAfterSave,
    ExitAfterUnknownOutcome(String),
}

fn previous_session_update_status(
    setting_name: &str,
    selected_id: &str,
    outcome: &SessionUpdateApplyOutcome,
) -> String {
    match outcome {
        SessionUpdateApplyOutcome::Applied => format!(
            "The previous session {setting_name} was changed to {selected_id}; the current session was not modified."
        ),
        SessionUpdateApplyOutcome::SessionUpdateFailed(error) => format!(
            "The previous session {setting_name} change to {selected_id} failed: {error}. Return to that session to retry."
        ),
        SessionUpdateApplyOutcome::OutcomeUnknown(error) => format!(
            "The previous session {setting_name} change to {selected_id} has an unknown outcome: {error}. This TUI is closing; reopen it, restore that session, and inspect its current {setting_name} before retrying."
        ),
    }
}

fn session_delete_feedback(
    session_name: &str,
    outcome: &SessionUpdateApplyOutcome,
) -> (bool, String) {
    match outcome {
        SessionUpdateApplyOutcome::Applied => {
            (true, format!("Session deleted: {session_name}"))
        }
        SessionUpdateApplyOutcome::SessionUpdateFailed(error) => (
            false,
            format!("Failed to delete session {session_name}: {error}"),
        ),
        SessionUpdateApplyOutcome::OutcomeUnknown(error) => (
            false,
            format!(
                "Session deletion for {session_name} has an unknown outcome: {error}. This TUI is closing; reopen it and inspect /sessions before retrying."
            ),
        ),
    }
}

fn session_update_completion_should_exit(exit_requested: bool, applied: bool) -> bool {
    exit_requested && applied
}

fn apply_agent_mode_feedback(
    current_mode: &mut String,
    chat_state: &mut ChatState,
    selected_mode: &str,
    outcome: SessionUpdateApplyOutcome,
) -> bool {
    match outcome {
        SessionUpdateApplyOutcome::SessionUpdateFailed(error) => {
            tracing::error!(
                "Failed to switch agent mode to {}: {}",
                selected_mode,
                error
            );
            chat_state.add_system_message(format!(
                "Agent mode was not changed: {error}. Please retry."
            ));
            false
        }
        SessionUpdateApplyOutcome::OutcomeUnknown(error) => {
            tracing::error!(
                "Agent mode update outcome is unknown for {}: {}",
                selected_mode,
                error
            );
            chat_state.add_system_message(format!(
                "Agent mode update outcome is unknown: {error}. This TUI is closing; reopen it, restore this session, and inspect its current mode before retrying."
            ));
            false
        }
        SessionUpdateApplyOutcome::Applied => {
            *current_mode = selected_mode.to_string();
            chat_state.agent_type = selected_mode.to_string();
            tracing::info!("Agent mode switched to: {}", selected_mode);
            true
        }
    }
}

fn apply_model_selection_feedback(
    chat_state: &mut ChatState,
    selected_display_name: &str,
    selected_id: &str,
    outcome: SessionUpdateApplyOutcome,
) -> bool {
    match outcome {
        SessionUpdateApplyOutcome::SessionUpdateFailed(error) => {
            tracing::error!(
                "Failed to switch model to {} ({}): {}",
                selected_display_name,
                selected_id,
                error
            );
            chat_state.add_system_message(format!(
                "Current session model was not changed: {error}. Please retry."
            ));
            false
        }
        SessionUpdateApplyOutcome::OutcomeUnknown(error) => {
            tracing::error!(
                "Model update outcome is unknown for {} ({}): {}",
                selected_display_name,
                selected_id,
                error
            );
            chat_state.add_system_message(format!(
                "Model update outcome is unknown: {error}. This TUI is closing; reopen it, restore this session, and inspect its current model before retrying."
            ));
            false
        }
        SessionUpdateApplyOutcome::Applied => {
            chat_state.current_model_id = Some(selected_id.to_string());
            chat_state.current_model_name = selected_display_name.to_string();
            tracing::info!(
                "Model switched to: {} ({})",
                selected_display_name,
                selected_id
            );
            true
        }
    }
}

fn apply_session_rename_feedback(
    chat_state: &mut ChatState,
    session_name: &str,
    outcome: SessionUpdateApplyOutcome,
) -> bool {
    match outcome {
        SessionUpdateApplyOutcome::SessionUpdateFailed(error) => {
            tracing::error!("Failed to rename the current session: {}", error);
            chat_state.add_system_message(format!(
                "Current session name was not changed: {error}. Please retry."
            ));
            false
        }
        SessionUpdateApplyOutcome::OutcomeUnknown(error) => {
            tracing::error!("Session rename outcome is unknown: {}", error);
            chat_state.add_system_message(format!(
                "Session rename outcome is unknown: {error}. This TUI is closing; reopen it, restore this session, and inspect its current name before retrying."
            ));
            false
        }
        SessionUpdateApplyOutcome::Applied => {
            chat_state.session_name = session_name.to_string();
            tracing::info!("Current session renamed");
            true
        }
    }
}

fn apply_session_model_fallback(
    chat_state: &mut ChatState,
    event_session_id: &str,
    previous_model_id: &str,
    new_model_id: &str,
    reason: &str,
) -> bool {
    if event_session_id != chat_state.core_session_id {
        tracing::debug!(
            "Ignoring model fallback for another session: current_session_id={}, event_session_id={}",
            chat_state.core_session_id,
            event_session_id
        );
        return false;
    }
    if chat_state.current_model_id.as_deref() != Some(previous_model_id) {
        tracing::debug!(
            "Ignoring stale model fallback: session_id={}, current_model_id={:?}, previous_model_id={}",
            event_session_id,
            chat_state.current_model_id,
            previous_model_id
        );
        return false;
    }
    chat_state.current_model_id = Some(new_model_id.to_string());
    chat_state.current_model_name = new_model_id.to_string();
    chat_state.add_system_message(format!(
        "The current session model changed from {previous_model_id} to {new_model_id} because {reason}."
    ));
    true
}

impl ChatMode {
    fn logout(&self, chat_state: &mut ChatState, rt_handle: &tokio::runtime::Handle) {
        let snapshot = tokio::task::block_in_place(|| {
            rt_handle.block_on(async {
                let account = self.account_runtime.as_ref().ok_or_else(|| {
                    anyhow!("Account management is unavailable for this TUI Host")
                })?;
                Ok::<_, anyhow::Error>(crate::account::account_snapshot_projection(
                    account.snapshot().await,
                ))
            })
        });
        match snapshot {
            Ok(snapshot) if !snapshot.logged_in => {
                chat_state.add_system_message("Not logged in.".to_string());
                return;
            }
            Err(error) => {
                chat_state.add_system_message(format!("Logout failed: {error}"));
                return;
            }
            Ok(_) => {}
        }
        match tokio::task::block_in_place(|| {
            rt_handle.block_on(async {
                let account = self.account_runtime.as_ref().ok_or_else(|| {
                    anyhow!("Account management is unavailable for this TUI Host")
                })?;
                account.logout().await?;
                Ok::<_, anyhow::Error>(crate::account::account_snapshot_projection(
                    account.snapshot().await,
                ))
            })
        }) {
            Ok(_) => chat_state.add_system_message("Logged out.".to_string()),
            Err(error) => chat_state.add_system_message(format!("Logout failed: {error}")),
        }
    }

    fn show_usage_report(
        &self,
        chat_view: &mut ChatView,
        chat_state: &mut ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) {
        if chat_state.is_processing {
            chat_view.set_status(Some(
                "Wait until the session is idle before using /usage.".to_string(),
            ));
            return;
        }

        let session_id = chat_state.core_session_id.clone();
        let workspace_path = chat_state
            .workspace
            .clone()
            .or_else(|| self.workspace.clone())
            .or_else(|| Some(self.agent.workspace_path_string()));
        // Sessions are stored under their owning project workspace; the bound
        // session names it by ID. Fall back to the client's own workspace ID only
        // when the chat still points at that same workspace.
        let workspace_id = chat_state
            .project_workspace_id()
            .map(str::to_string)
            .or_else(|| {
                let agent_path = self.agent.workspace_path_string();
                (workspace_path
                    .as_deref()
                    .is_none_or(|path| path == agent_path))
                .then(|| self.agent.workspace_id())
                .flatten()
            });
        let agent = self.agent.clone();

        /*
         * Rendered into the conversation view and nowhere else. A report about
         * a session is not an event in it, and this used to write one as a
         * `local_command` Turn as well — which the desktop then loaded from
         * disk and gave a numbered slot in its Turn rail, because the ordinals
         * come from the backend catalog and the catalog counts what is stored.
         *
         * `add_assistant_message` is already the UI-only path: `turn_id: None`,
         * never persisted, never in model context. In a terminal the scrollback
         * is the record, so nothing here needs to replace what is being removed.
         */
        let report_result: Result<openbitfun_core::service::session_usage::SessionUsageReport> =
            tokio::task::block_in_place(|| {
                let session_id = session_id.clone();
                let workspace_path = workspace_path.clone();
                let agent = agent.clone();
                rt_handle.block_on(async move {
                    let workspace_path = workspace_path
                        .filter(|path| !path.trim().is_empty())
                        .ok_or_else(|| anyhow!("Workspace path is required for usage reports"))?;

                    agent
                        .generate_session_usage_report(AgentSessionUsageRequest {
                            workspace_id,
                            session_id,
                            workspace_path: Some(workspace_path),
                            remote_connection_id: None,
                            remote_ssh_host: None,
                            include_hidden_subagents: true,
                        })
                        .await
                })
            });

        match report_result {
            Ok(report) => {
                chat_state.add_assistant_message(render_usage_report_markdown(&report));
                chat_view.set_status(Some("Usage report added to conversation".to_string()));
            }
            Err(error) => {
                chat_state
                    .add_system_message(format!("Failed to generate usage report: {}", error));
            }
        }
    }

    fn list_available_themes(&self) -> Vec<ThemeItem> {
        let mut themes = Vec::new();
        for id in builtin_theme_ids() {
            themes.push(ThemeItem { id });
        }

        themes.sort_by_cached_key(|theme| theme.id.to_ascii_lowercase());
        themes.dedup_by(|a, b| a.id == b.id);
        themes
    }

    fn resolve_configured_theme(
        &self,
        base: Theme,
        appearance: Appearance,
        scheme: EffectiveColorScheme,
    ) -> Theme {
        self.resolve_theme_by_id(base, appearance, scheme, self.config.ui.theme_id.trim())
    }

    fn resolve_theme_by_id(
        &self,
        base: Theme,
        appearance: Appearance,
        scheme: EffectiveColorScheme,
        id: &str,
    ) -> Theme {
        if scheme == EffectiveColorScheme::Monochrome {
            return Theme::monochrome();
        }

        if id.is_empty() {
            return base;
        }

        if let Some(json) = builtin_theme_json(id) {
            return base
                .apply_opencode_theme_json(json, appearance)
                .unwrap_or(base)
                .with_effective_scheme(scheme);
        }

        base
    }

    fn preview_theme_selection(&mut self, theme: &ThemeItem, chat_view: &mut ChatView) {
        let appearance = resolve_appearance(&self.config.ui.theme);
        let scheme = resolve_effective_color_scheme(&self.config.ui.color_scheme);
        let base_is_light = appearance.is_light();
        let base = match (base_is_light, scheme) {
            (_, EffectiveColorScheme::Monochrome) => Theme::monochrome(),
            (true, EffectiveColorScheme::Ansi16) => Theme::light_ansi16(),
            (true, EffectiveColorScheme::Truecolor) => Theme::light(),
            (false, EffectiveColorScheme::Ansi16) => Theme::dark_ansi16(),
            (false, EffectiveColorScheme::Truecolor) => Theme::dark(),
        };

        let resolved = self.resolve_theme_by_id(base, appearance, scheme, theme.id.trim());
        chat_view.set_theme(resolved);
        chat_view.set_status(Some(format!(
            "Preview theme: {} (Enter apply, Esc cancel)",
            theme.id
        )));
    }

    fn apply_theme_selection(&mut self, theme: &ThemeItem, chat_view: &mut ChatView) {
        let appearance = resolve_appearance(&self.config.ui.theme);
        let scheme = resolve_effective_color_scheme(&self.config.ui.color_scheme);
        let base_is_light = appearance.is_light();
        let base = match (base_is_light, scheme) {
            (_, EffectiveColorScheme::Monochrome) => Theme::monochrome(),
            (true, EffectiveColorScheme::Ansi16) => Theme::light_ansi16(),
            (true, EffectiveColorScheme::Truecolor) => Theme::light(),
            (false, EffectiveColorScheme::Ansi16) => Theme::dark_ansi16(),
            (false, EffectiveColorScheme::Truecolor) => Theme::dark(),
        };

        if let Err(e) = self
            .config
            .update(|config| config.ui.theme_id = theme.id.clone())
        {
            chat_view.set_status(Some(format!("Failed to save config: {}", e)));
        }

        let resolved = self.resolve_theme_by_id(base, appearance, scheme, theme.id.trim());
        chat_view.set_theme(resolved);
        chat_view.set_status(Some(format!("Theme set to: {}", theme.id)));
    }

    fn get_mode_agents(&self, rt_handle: &tokio::runtime::Handle) -> Vec<TuiAgentMode> {
        tokio::task::block_in_place(|| {
            rt_handle
                .block_on(self.agent.available_agent_modes())
                .unwrap_or_else(|error| {
                    tracing::warn!("Failed to load main agent modes: {error}");
                    Vec::new()
                })
        })
    }

    fn cycle_agent(
        &mut self,
        chat_view: &mut ChatView,
        chat_state: &mut ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) {
        self.switch_agent_by_offset(1, chat_view, chat_state, rt_handle);
    }

    fn cycle_agent_reverse(
        &mut self,
        chat_view: &mut ChatView,
        chat_state: &mut ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) {
        self.switch_agent_by_offset(-1, chat_view, chat_state, rt_handle);
    }

    fn switch_agent_by_offset(
        &mut self,
        offset: isize,
        chat_view: &mut ChatView,
        chat_state: &mut ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) {
        if !session_update_allowed(
            chat_state.is_processing,
            self.pending_session_operation.is_some(),
        ) {
            chat_view.set_status(Some(session_update_unavailable_message(
                "Agent mode",
                chat_state.is_processing,
            )));
            return;
        }
        let modes = self.get_mode_agents(rt_handle);
        if modes.len() <= 1 {
            return;
        }

        let current_idx = modes
            .iter()
            .position(|m| m.id == self.agent_type)
            .unwrap_or(0);

        let len = modes.len() as isize;
        let next_idx = ((current_idx as isize + offset) % len + len) % len;
        let next = &modes[next_idx as usize];

        let selected = AgentItem {
            id: next.id.clone(),
            route_key: (!next.route_key.is_empty()).then(|| next.route_key.clone()),
            description: next.description.clone(),
        };
        self.apply_agent_selection(&selected, chat_view, chat_state, rt_handle);
    }

    /// Resolve the Runtime-owned Session model through the local product catalog.
    fn load_current_model_name(
        &self,
        chat_state: &mut ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) {
        let session_model_id = chat_state.current_model_id.clone();
        let result: Option<String> = tokio::task::block_in_place(|| {
            rt_handle.block_on(async {
                if self.agent.is_remote_workspace() {
                    return None;
                }
                let config_owner = openbitfun_core::service::config::get_global_config_service()
                    .await
                    .ok()?;
                let models = config_owner.get_ai_models().await.ok()?;
                let config = config_owner.get_config(None).await.ok()?;
                let catalog = crate::model_selection::model_list_projection(&models, &config);
                let model_id = crate::model_selection::resolve_tui_model_id(
                    &catalog,
                    session_model_id.as_deref(),
                )?;
                Some(
                    catalog
                        .models
                        .iter()
                        .find(|model| model.id == model_id)
                        .map(crate::model_selection::tui_model_display_name)
                        .unwrap_or(model_id),
                )
            })
        });

        if let Some(name) = result {
            chat_state.current_model_name = name;
        } else if let Some(model_id) = chat_state.current_model_id.as_ref() {
            chat_state.current_model_name = model_id.clone();
        }
    }

    /// Show model selector popup with all available models
    fn show_model_selector(
        &self,
        chat_view: &mut ChatView,
        chat_state: &mut ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) {
        let result = tokio::task::block_in_place(|| {
            rt_handle.block_on(async {
                if self.agent.is_remote_workspace() {
                    return None;
                }
                let config_owner = openbitfun_core::service::config::get_global_config_service()
                    .await
                    .ok()?;
                let models = config_owner.get_ai_models().await.ok()?;
                let config = config_owner.get_config(None).await.ok()?;
                let catalog = crate::model_selection::model_list_projection(&models, &config);
                let current_model_id = crate::model_selection::resolve_tui_model_id(
                    &catalog,
                    chat_state.current_model_id.as_deref(),
                );
                let model_items: Vec<ModelItem> = catalog
                    .models
                    .into_iter()
                    .filter(|model| model.enabled)
                    .map(|model| ModelItem {
                        id: model.id,
                        name: model.name,
                        provider: model.provider,
                        model_name: model.model_name,
                    })
                    .collect();
                Some((model_items, current_model_id))
            })
        });

        match result {
            Some((models, current_id)) if !models.is_empty() => {
                chat_view.show_model_selector(models, current_id, !self.agent.is_shared(), true);
            }
            _ => {
                chat_state.add_system_message(
                    "No available models found. Please configure models first.".to_string(),
                );
            }
        }
    }

    /// Apply only the current Session model through the Runtime owner.
    fn apply_model_selection(
        &mut self,
        selected: &ModelItem,
        chat_view: &mut ChatView,
        chat_state: &mut ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) {
        let selected_id = selected.id.clone();
        let selected_display_name = format!("{} / {}", selected.model_name, selected.name);
        if chat_state.current_model_id.as_deref() == Some(selected_id.as_str()) {
            chat_view.set_status(Some(format!(
                "Current session already uses {selected_display_name}"
            )));
            return;
        }
        if !session_update_allowed(
            chat_state.is_processing,
            self.pending_session_operation.is_some(),
        ) {
            chat_view.set_status(Some(session_update_unavailable_message(
                "Model",
                chat_state.is_processing,
            )));
            return;
        }
        let session_id = chat_state.core_session_id.clone();
        let task_session_id = session_id.clone();
        let task_model_id = selected_id.clone();
        let agent = self.agent.clone();
        chat_view.set_status(Some(format!(
            "Changing current session model to {selected_display_name}..."
        )));
        let handle = rt_handle.spawn(async move {
            agent
                .update_session_model(&task_session_id, &task_model_id)
                .await
        });
        self.pending_session_operation = Some(PendingSessionOperation {
            session_id,
            kind: PendingSessionOperationKind::Model {
                model_id: selected_id,
                display_name: selected_display_name,
            },
            started_at: Instant::now(),
            slow_notice_shown: false,
            exit_warning_shown: false,
            handle,
        });
    }

    /// Show agent selector popup with all available agent modes
    fn show_agent_selector(
        &self,
        chat_view: &mut ChatView,
        chat_state: &mut ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) {
        let modes = self.get_mode_agents(rt_handle);
        if modes.is_empty() {
            let message = if self.agent.is_shared() {
                "Main agent modes are unavailable."
            } else {
                "Main agent modes are unavailable; agent management remains available."
            };
            chat_view.set_status(Some(message.to_string()));
            if self.agent.is_shared() {
                return;
            }
        }

        let agent_items: Vec<AgentItem> = modes
            .into_iter()
            .map(|m| AgentItem {
                id: m.id,
                route_key: (!m.route_key.is_empty()).then_some(m.route_key),
                description: m.description,
            })
            .collect();

        let allow_mode_switch = session_update_allowed(
            chat_state.is_processing,
            self.pending_session_operation.is_some(),
        );
        chat_view.show_agent_selector(
            agent_items,
            Some(self.agent_type.clone()),
            !self.agent.is_shared(),
            allow_mode_switch,
        );
    }

    fn handle_agent_selector_action(
        &mut self,
        action: AgentSelectorAction,
        chat_view: &mut ChatView,
        chat_state: &mut ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) {
        match action {
            AgentSelectorAction::SwitchMode(selected) => {
                if !session_update_allowed(
                    chat_state.is_processing,
                    self.pending_session_operation.is_some(),
                ) {
                    chat_view.set_status(Some(session_update_unavailable_message(
                        "Agent mode",
                        chat_state.is_processing,
                    )));
                    return;
                }
                chat_view.hide_agent_selector();
                self.apply_agent_selection(&selected, chat_view, chat_state, rt_handle);
            }
            AgentSelectorAction::ManageSubagents => {
                self.show_subagent_selector(chat_view, chat_state, rt_handle);
            }
            AgentSelectorAction::ReviewExternalSources => {
                chat_view.hide_agent_selector();
                self.handle_external_agent_review("", chat_view, chat_state, rt_handle);
            }
        }
    }

    /// Apply agent selection: switch agent type
    fn apply_agent_selection(
        &mut self,
        selected: &AgentItem,
        chat_view: &mut ChatView,
        chat_state: &mut ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) {
        if self.pending_session_operation.is_some() {
            chat_view.set_status(Some(
                "A Session operation is already in progress. Please wait.".to_string(),
            ));
            return;
        }

        let session_id = chat_state.core_session_id.clone();
        let mode_id = selected.id.clone();
        let route_key = selected.route_key.clone();
        let task_mode_id = mode_id.clone();
        let agent = self.agent.clone();
        chat_view.set_status(Some(format!("Switching agent mode to {mode_id}...")));
        let task_session_id = session_id.clone();
        let handle = rt_handle.spawn(async move {
            agent
                .update_session_mode_with_route(
                    &task_session_id,
                    &task_mode_id,
                    route_key.as_deref(),
                )
                .await
        });
        self.pending_session_operation = Some(PendingSessionOperation {
            session_id,
            kind: PendingSessionOperationKind::Mode { mode_id },
            started_at: Instant::now(),
            slow_notice_shown: false,
            exit_warning_shown: false,
            handle,
        });
    }

    fn poll_session_operation_completion(
        &mut self,
        chat_view: &mut ChatView,
        chat_state: &mut ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) -> SessionUpdatePollOutcome {
        let Some(pending) = self.pending_session_operation.as_mut() else {
            return SessionUpdatePollOutcome::NoChange;
        };
        if !pending.handle.is_finished() {
            if !pending.slow_notice_shown
                && pending.started_at.elapsed() >= SESSION_OPERATION_SLOW_NOTICE
            {
                pending.slow_notice_shown = true;
                if !pending.exit_warning_shown {
                    let message = if self.agent.is_shared() {
                        "The Session operation is still running. You can keep editing; changing sessions and sending wait for the result."
                    } else {
                        "The Session operation is still running. You can edit or switch sessions; sending in the affected Session waits."
                    };
                    chat_view.set_status(Some(message.to_string()));
                }
                return SessionUpdatePollOutcome::Redraw;
            }
            return SessionUpdatePollOutcome::NoChange;
        }
        let pending = self
            .pending_session_operation
            .take()
            .expect("finished session operation should remain present");
        let outcome = match tokio::task::block_in_place(|| rt_handle.block_on(pending.handle)) {
            Ok(Ok(())) => SessionUpdateApplyOutcome::Applied,
            Ok(Err(error)) if error.outcome_unknown() => {
                SessionUpdateApplyOutcome::OutcomeUnknown(error.to_string())
            }
            Ok(Err(error)) => SessionUpdateApplyOutcome::SessionUpdateFailed(error.to_string()),
            Err(error) => SessionUpdateApplyOutcome::SessionUpdateFailed(format!(
                "session operation task failed: {error}"
            )),
        };
        let unknown_outcome = matches!(&outcome, SessionUpdateApplyOutcome::OutcomeUnknown(_));
        if let PendingSessionOperationKind::Delete { session_name } = &pending.kind {
            let (remove_item, status) = session_delete_feedback(session_name, &outcome);
            if remove_item {
                chat_view.session_selector_remove_item(&pending.session_id);
                chat_view.forget_session_composer(&pending.session_id);
                tracing::info!("Deleted session: {}", pending.session_id);
            } else {
                tracing::error!(
                    session_id = %pending.session_id,
                    outcome = if unknown_outcome { "unknown" } else { "failed" },
                    "Session deletion was not confirmed"
                );
            }
            chat_view.set_status(Some(status.clone()));
            if unknown_outcome {
                return SessionUpdatePollOutcome::ExitAfterUnknownOutcome(status);
            }
            chat_view.reshow_session_selector();
            return if session_update_completion_should_exit(pending.exit_warning_shown, remove_item)
            {
                SessionUpdatePollOutcome::ExitAfterSave
            } else {
                SessionUpdatePollOutcome::Redraw
            };
        }
        if chat_state.core_session_id != pending.session_id {
            if let SessionUpdateApplyOutcome::SessionUpdateFailed(error) = &outcome {
                tracing::error!(
                    "Failed to change previous session {} {} to {}: {}",
                    pending.session_id,
                    pending.kind.name(),
                    pending.kind.selected_id(),
                    error
                );
            }
            let status = previous_session_update_status(
                pending.kind.name(),
                pending.kind.selected_id(),
                &outcome,
            );
            chat_view.set_status(Some(status.clone()));
            if unknown_outcome {
                return SessionUpdatePollOutcome::ExitAfterUnknownOutcome(status);
            }
            return SessionUpdatePollOutcome::Redraw;
        }
        let applied = match &pending.kind {
            PendingSessionOperationKind::Mode { mode_id } => {
                apply_agent_mode_feedback(&mut self.agent_type, chat_state, mode_id, outcome)
            }
            PendingSessionOperationKind::Model {
                model_id,
                display_name,
            } => apply_model_selection_feedback(chat_state, display_name, model_id, outcome),
            PendingSessionOperationKind::Rename { session_name } => {
                apply_session_rename_feedback(chat_state, session_name, outcome)
            }
            PendingSessionOperationKind::Delete { .. } => {
                unreachable!("session deletion is handled before current-session feedback")
            }
        };
        if applied {
            chat_view.set_status(Some(format!(
                "Current session {} set to {}",
                pending.kind.name(),
                pending.kind.selected_id()
            )));
        } else if unknown_outcome {
            let message = format!(
                "Current session {} update outcome is unknown. This TUI is closing; reopen it, restore the session, and inspect its current {} before retrying.",
                pending.kind.name(),
                pending.kind.name()
            );
            chat_view.set_status(Some(message.clone()));
            return SessionUpdatePollOutcome::ExitAfterUnknownOutcome(message);
        } else {
            chat_view.set_status(Some(format!(
                "Current session {} change failed. Please retry.",
                pending.kind.name()
            )));
        }

        if applied
            && matches!(
                &pending.kind,
                PendingSessionOperationKind::Mode { mode_id } if mode_id == "HarmonyOSDev"
            )
        {
            let deveco_home = std::env::var("DEVECO_HOME").ok();
            let missing = deveco_home
                .as_deref()
                .map(|s| s.trim().is_empty())
                .unwrap_or(true);
            if missing {
                chat_state.add_system_message(
                    "HarmonyOSDev tip: HmosCompilation requires DEVECO_HOME (DevEco Studio install path). If compilation fails, set DEVECO_HOME and restart the terminal."
                        .to_string(),
                );
            }
        }
        if session_update_completion_should_exit(pending.exit_warning_shown, applied) {
            SessionUpdatePollOutcome::ExitAfterSave
        } else {
            SessionUpdatePollOutcome::Redraw
        }
    }

    // ============ MCP management ============
}

fn session_update_allowed(is_processing: bool, update_pending: bool) -> bool {
    !is_processing && !update_pending
}

fn session_update_unavailable_message(setting_name: &str, is_processing: bool) -> String {
    if is_processing {
        format!("{setting_name} cannot be changed during the current turn.")
    } else {
        "A Session operation is already in progress. Please wait.".to_string()
    }
}

#[cfg(test)]
mod usage_metadata_tests {
    use super::{session_update_allowed, session_update_unavailable_message};

    #[test]
    fn session_update_is_rechecked_when_an_idle_popup_outlives_turn_start() {
        assert!(session_update_allowed(false, false));
        assert!(!session_update_allowed(true, false));
        assert!(!session_update_allowed(false, true));
    }

    #[test]
    fn active_turn_message_does_not_advertise_hidden_management() {
        let message = session_update_unavailable_message("Agent mode", true);

        assert_eq!(
            message,
            "Agent mode cannot be changed during the current turn."
        );
    }
}
