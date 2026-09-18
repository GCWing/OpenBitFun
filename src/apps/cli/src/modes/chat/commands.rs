fn session_update_blocks_typed_submission(pending_for_current_session: bool, input: &str) -> bool {
    pending_for_current_session && !input.trim().starts_with('/')
}

fn steering_unsupported_reason(draft: &crate::ui::composer::ComposerDraft) -> Option<&'static str> {
    if draft.has_images() {
        return Some(
            "Images cannot steer an active turn yet. Wait for it to finish to send this draft.",
        );
    }
    if !draft.workspace_references.is_empty() {
        return Some(
            "Workspace references cannot steer an active turn yet. Wait for it to finish to send this draft.",
        );
    }
    None
}

fn parse_reload_target(
    arguments: &str,
) -> std::result::Result<openbitfun_runtime_ports::AgentContextReloadTarget, &'static str> {
    use openbitfun_runtime_ports::AgentContextReloadTarget;

    match arguments.trim().to_ascii_lowercase().as_str() {
        "" => Ok(AgentContextReloadTarget::All),
        "skills" => Ok(AgentContextReloadTarget::Skills),
        "instructions" => Ok(AgentContextReloadTarget::Instructions),
        _ => Err("Usage: /reload [skills|instructions]"),
    }
}

fn parse_reload_invocation(
    command_name: &str,
    arguments: &str,
) -> Option<std::result::Result<openbitfun_runtime_ports::AgentContextReloadTarget, &'static str>> {
    if command_name.eq_ignore_ascii_case("reload") {
        return Some(parse_reload_target(arguments));
    }
    if command_name.eq_ignore_ascii_case("reload-skills") {
        return Some(if arguments.trim().is_empty() {
            Ok(openbitfun_runtime_ports::AgentContextReloadTarget::Skills)
        } else {
            Err("Usage: /reload-skills (or /reload skills)")
        });
    }
    None
}

fn pending_session_operation_blocks_runtime_action(
    shared_tui: bool,
    pending_for_current_session: bool,
    handler: ActionHandler,
) -> bool {
    pending_for_current_session
        && (matches!(
            handler,
            ActionHandler::UndoSession | ActionHandler::RedoSession
        ) || shared_tui
            && matches!(
                handler,
                ActionHandler::Sessions
                    | ActionHandler::ForkSession
                    | ActionHandler::RenameSession
                    | ActionHandler::CompactSession
                    | ActionHandler::Init
            ))
}

pub(crate) fn pending_workspace_diff_blocks_runtime_action(
    shared_tui: bool,
    pending_workspace_diff: bool,
    handler: ActionHandler,
) -> bool {
    shared_tui
        && pending_workspace_diff
        && matches!(
            handler,
            ActionHandler::OpenAgentSelector
                | ActionHandler::SwitchAgent
                | ActionHandler::SwitchAgentReverse
                | ActionHandler::SelectModel
                | ActionHandler::NewSession
                | ActionHandler::Sessions
                | ActionHandler::ForkSession
                | ActionHandler::UndoSession
                | ActionHandler::RedoSession
                | ActionHandler::RenameSession
                | ActionHandler::Reload
                | ActionHandler::Init
                | ActionHandler::WorkspaceDiff
                | ActionHandler::CompactSession
                | ActionHandler::SubmitInput
                | ActionHandler::Interrupt
        )
}

fn requested_session_name(arguments: &str) -> Option<String> {
    let session_name = arguments.trim();
    (!session_name.is_empty()).then(|| session_name.to_string())
}

fn native_command_choice_is_active(
    resolved: Option<&ExternalCommandProjection>,
    unresolved: &[ExternalCommandProjection],
) -> bool {
    resolved
        .into_iter()
        .chain(unresolved)
        .filter_map(|candidate| candidate.native_collision.as_ref())
        .any(|collision| {
            collision.selected_candidate_id.as_deref()
                == Some(collision.native_candidate_id.as_str())
        })
}

fn native_command_reconfirmation_is_required(
    resolved_external_exists: bool,
    historical_reconfirmation_pending: bool,
    current_native_choice_is_active: bool,
) -> bool {
    !resolved_external_exists
        && historical_reconfirmation_pending
        && !current_native_choice_is_active
}

fn builtin_arguments_route(route: CommandRoute, handler: ActionHandler) -> bool {
    route == CommandRoute::Builtin && handler == ActionHandler::RenameSession
}

fn builtin_arguments_error(
    route: CommandRoute,
    handler: ActionHandler,
    arguments: &str,
) -> Option<&'static str> {
    if route != CommandRoute::Builtin || arguments.trim().is_empty() {
        return None;
    }

    match handler {
        ActionHandler::CompactSession => Some("Usage: /compact"),
        ActionHandler::ForkSession => Some("Usage: /fork"),
        ActionHandler::Timeline => Some("Usage: /timeline"),
        ActionHandler::UndoSession => Some("Usage: /undo"),
        ActionHandler::RedoSession => Some("Usage: /redo"),
        ActionHandler::WorkspaceDiff => Some("Usage: /diff"),
        ActionHandler::Editor => Some("Usage: /editor"),
        ActionHandler::ToggleTimestamps => Some("Usage: /timestamps"),
        ActionHandler::ToggleThinking => Some("Usage: /thinking"),
        ActionHandler::CopyTranscript => Some("Usage: /copy"),
        ActionHandler::ExportTranscript => Some("Usage: /export"),
        _ => None,
    }
}

fn selected_command_prefill(handler: ActionHandler) -> Option<&'static str> {
    match handler {
        ActionHandler::RenameSession => Some("/rename "),
        _ => None,
    }
}

fn begin_slash_menu_selection(
    selected_command: &mut Option<String>,
    selected_command_name: Option<&str>,
) {
    if selected_command_name.is_some() {
        *selected_command = None;
    }
}

fn consume_selected_native_command_once(
    selected_command: &mut Option<String>,
    command_name: &str,
) -> bool {
    selected_command
        .take()
        .is_some_and(|selected| selected.eq_ignore_ascii_case(command_name))
}

fn retain_selected_native_command_for_input(selected_command: &mut Option<String>, input: &str) {
    let still_selected = selected_command.as_deref().is_some_and(|selected| {
        input
            .trim_start()
            .split_whitespace()
            .next()
            .map(|token| token.trim_start_matches('/'))
            .is_some_and(|command| command.eq_ignore_ascii_case(selected))
    });
    if !still_selected {
        *selected_command = None;
    }
}

fn clear_selected_native_command_prefill(
    selected_command: &mut Option<String>,
    chat_view: &mut ChatView,
) {
    if selected_command.take().is_some() {
        chat_view.clear_input();
    }
}

fn session_command_help_note() -> String {
    let rename = action_for_alias("/rename", ActionContext::Chat)
        .expect("current session rename action must remain registered");
    let fork = action_for_alias("/fork", ActionContext::Chat)
        .expect("current session fork action must remain registered");
    let timeline = action_for_alias("/timeline", ActionContext::Chat)
        .expect("current session timeline action must remain registered");
    let undo = action_for_alias("/undo", ActionContext::Chat)
        .expect("current session undo action must remain registered");
    let redo = action_for_alias("/redo", ActionContext::Chat)
        .expect("current session redo action must remain registered");
    format!(
        "Session Commands\n  /timeline - {}\n  /fork - {}\n  /rename <name> - {}\n  /undo - {}\n  /redo - {}",
        timeline.description, fork.description, rename.description, undo.description, redo.description
    )
}

impl ChatMode {
    fn sync_selected_native_command(&mut self, chat_view: &ChatView) {
        retain_selected_native_command_for_input(
            &mut self.selected_native_command_once,
            chat_view.input_text(),
        );
    }

    /// Handle command palette action
    fn handle_palette_action(
        &mut self,
        action_id: &str,
        chat_view: &mut ChatView,
        chat_state: &mut ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) -> Result<Option<ChatExitReason>> {
        // Hide command palette but keep it in stack for back navigation
        // (unless the action switches away or exits)
        let keep_in_stack = matches!(action_id, "new_session" | "exit");
        if !keep_in_stack {
            chat_view.hide_command_palette();
        }
        self.handle_action_id(action_id, None, chat_view, chat_state, rt_handle)
    }

    fn handle_action_id(
        &mut self,
        action_id: &str,
        selected_command_name: Option<&str>,
        chat_view: &mut ChatView,
        chat_state: &mut ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) -> Result<Option<ChatExitReason>> {
        let displayed_is_processing = self.displayed_chat_state(chat_state).is_processing;
        begin_slash_menu_selection(
            &mut self.selected_native_command_once,
            selected_command_name,
        );
        if action_id == "toggle_auto_approve" || action_id.starts_with("toggle_auto_approve:") {
            let action = action_by_id("toggle_auto_approve", ActionContext::Chat)
                .expect("Auto mode action must remain registered");
            let state = self.action_state(displayed_is_processing, false);
            if !action.available(state) {
                chat_view.set_status(Some(action.unavailable_message(state)));
                return Ok(None);
            }
            let argument = action_id.strip_prefix("toggle_auto_approve:");
            let next = match argument {
                Some("on") => Some(true),
                Some("off") => Some(false),
                Some("default") => None,
                _ => Some(!chat_state.auto_approve_ask),
            };
            self.auto_approve_ask_override = next;
            chat_state.auto_approve_ask = next.unwrap_or(self.auto_approve_ask_default);
            self.agent
                .set_approval_policy(if chat_state.auto_approve_ask {
                    crate::runtime::approval::CliApprovalPolicy::Auto
                } else if next.is_some() {
                    crate::runtime::approval::CliApprovalPolicy::DisableAuto
                } else {
                    crate::runtime::approval::CliApprovalPolicy::Ask
                });
            chat_view.set_status(Some(if next.is_none() {
                format!(
                    "Auto mode reset to user default ({}) for this session",
                    if self.auto_approve_ask_default {
                        "on"
                    } else {
                        "off"
                    }
                )
            } else if chat_state.auto_approve_ask {
                "Auto mode enabled for this session".to_string()
            } else {
                "Auto mode disabled for this session".to_string()
            }));
            return Ok(None);
        }
        if let Some(external) = self.external_command_projection_for_action(action_id) {
            return self.select_and_handle_external_command(
                &external, "", chat_view, chat_state, rt_handle,
            );
        }
        let Some(action) = action_by_id(action_id, ActionContext::Chat) else {
            chat_view.set_status(Some(format!("Unknown action: {action_id}")));
            return Ok(None);
        };
        if !action_opens_extension_management(action) {
            if let Some(projection) =
                self.native_command_collision_for_action(action.id, selected_command_name)
            {
                let collision = projection
                    .native_collision
                    .as_ref()
                    .expect("collision projection must include native collision facts");
                self.remember_native_command_choice(
                    &collision.native_action_id,
                    &projection.command_name,
                    &collision.native_candidate_id,
                    chat_view,
                    rt_handle,
                );
            } else if let Some(reconfirmation) = action
                .aliases
                .iter()
                .filter(|alias| {
                    selected_command_name
                        .map(|selected| {
                            alias.trim_start_matches('/').eq_ignore_ascii_case(selected)
                        })
                        .unwrap_or(true)
                })
                .find_map(|alias| {
                    builtin_command_reconfirmation(
                        action.id,
                        alias,
                        &self.external_conflict_preferences(),
                    )
                    .filter(|reconfirmation| !reconfirmation.confirmed)
                })
            {
                self.remember_native_command_choice(
                    action.id,
                    &reconfirmation.command_name,
                    &reconfirmation.candidate_id,
                    chat_view,
                    rt_handle,
                );
            }
        }
        if let Some(selected_command_name) = selected_command_name {
            if let Some(prefill) = selected_command_prefill(action.handler) {
                self.selected_native_command_once =
                    Some(selected_command_name.to_ascii_lowercase());
                chat_view.set_input(prefill);
                return Ok(None);
            }
        }
        self.dispatch_action(
            action,
            self.action_state(displayed_is_processing, false),
            chat_view,
            chat_state,
            rt_handle,
        )
    }

    /// Handle shortcut commands
    fn handle_command(
        &mut self,
        command: &str,
        chat_view: &mut ChatView,
        chat_state: &mut ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) -> Result<Option<ChatExitReason>> {
        let parts: Vec<&str> = command.split_whitespace().collect();
        if parts.is_empty() {
            return Ok(None);
        }

        let token = parts[0];
        let entered_command_name = token.trim_start_matches('/');
        let arguments = command
            .get(token.len()..)
            .map(str::trim_start)
            .unwrap_or("");
        let command_name = entered_command_name;
        let selected_native_once = consume_selected_native_command_once(
            &mut self.selected_native_command_once,
            command_name,
        );
        let reload_invocation = parse_reload_invocation(entered_command_name, arguments);
        if command_name == "auto" {
            let action_id = match arguments.trim() {
                "on" | "enable" => "toggle_auto_approve:on",
                "off" | "disable" => "toggle_auto_approve:off",
                "default" | "reset" => "toggle_auto_approve:default",
                "" | "toggle" => "toggle_auto_approve",
                other => {
                    chat_view.set_status(Some(format!(
                        "Usage: /auto [on|off|default|toggle] (current: {})",
                        if chat_state.auto_approve_ask {
                            "on"
                        } else {
                            "off"
                        }
                    )));
                    chat_state.add_system_message(format!(
                        "Unknown Auto mode value '{other}'. Use on, off, default, or toggle."
                    ));
                    return Ok(None);
                }
            };
            return self.handle_action_id(action_id, None, chat_view, chat_state, rt_handle);
        }
        if command_name.eq_ignore_ascii_case("worktree") {
            return self.handle_worktree_command(arguments, chat_view, chat_state, rt_handle);
        }
        if command_name.eq_ignore_ascii_case("reload-skills") {
            return self.handle_reload_invocation(
                reload_invocation.expect("legacy reload alias requires a parsed invocation"),
                chat_view,
                chat_state,
                rt_handle,
            );
        }
        let builtin_alias = format!("/{command_name}");
        let builtin_action = action_for_alias(&builtin_alias, ActionContext::Chat);
        let mut external = self.external_command_projection(command_name);
        let authoritative_preferences = tokio::task::block_in_place(|| {
            rt_handle.block_on(async {
                openbitfun_core::external_sources::external_source_conflict_choices()
                    .await
                    .map(ExternalSourceConflictPreferences::from)
            })
        });
        if let Ok(authoritative_preferences) = authoritative_preferences {
            if authoritative_preferences != self.external_conflict_preferences() {
                self.replace_external_conflict_preferences(authoritative_preferences);
                external = self.external_command_projection(command_name);
                if let Some(snapshot) = &self.external_source_snapshot {
                    self.update_external_source_view(chat_view, snapshot);
                }
            }
        }
        let builtin_reconfirmation = builtin_action.and_then(|action| {
            builtin_command_reconfirmation(
                action.id,
                command_name,
                &self.external_conflict_preferences(),
            )
        });
        let unresolved_candidates = self.external_conflict_projections(command_name);
        let native_choice_is_active =
            native_command_choice_is_active(external.as_ref(), &unresolved_candidates);
        let builtin_reconfirmation_required = native_command_reconfirmation_is_required(
            external.is_some(),
            builtin_reconfirmation
                .as_ref()
                .is_some_and(|reconfirmation| !reconfirmation.confirmed),
            native_choice_is_active,
        );
        let route = if selected_native_once
            && builtin_action.is_some_and(|action| action.handler == ActionHandler::RenameSession)
        {
            CommandRoute::Builtin
        } else {
            command_route(
                builtin_action.is_some(),
                external.as_ref(),
                self.external_source_snapshot
                    .as_ref()
                    .is_some_and(|snapshot| snapshot.discovery_pending),
                builtin_reconfirmation_required,
            )
        };
        if let Some(action) = builtin_action {
            if let Some(usage) = builtin_arguments_error(route, action.handler, arguments) {
                chat_view.set_status(Some(usage.to_string()));
                return Ok(None);
            }
        }
        if let Some(action) = builtin_action {
            if builtin_arguments_route(route, action.handler) {
                let state = self.action_state(chat_state.is_processing, false);
                if !action.available(state) {
                    chat_view.set_status(Some(action.unavailable_message(state)));
                    return Ok(None);
                }
                return self.start_session_rename(arguments, chat_view, chat_state, rt_handle);
            }
        }
        if route == CommandRoute::Builtin {
            if let Some(help) = extension_command_help_request(command_name, arguments) {
                chat_state.add_system_message(help);
                return Ok(None);
            }
        }
        let native_management_available = route == CommandRoute::Builtin
            && (external.is_none() || native_choice_is_active)
            && (unresolved_candidates.is_empty() || native_choice_is_active);
        let can_route_external_tool_review = builtin_action
            .is_some_and(|action| action.handler == ActionHandler::Tools)
            && native_management_available;
        if can_route_external_tool_review {
            self.handle_external_tool_review(arguments, chat_view, chat_state, rt_handle);
            return Ok(None);
        }
        let can_route_external_agent_review = builtin_action
            .is_some_and(|action| action.handler == ActionHandler::OpenAgentSelector)
            && !arguments.trim().is_empty()
            && native_management_available;
        if can_route_external_agent_review {
            self.handle_external_agent_review(arguments, chat_view, chat_state, rt_handle);
            return Ok(None);
        }
        let can_route_external_control = builtin_action
            .is_some_and(|action| action.handler == ActionHandler::Extensions)
            && native_management_available;
        if can_route_external_control {
            self.handle_external_control(arguments, chat_view, chat_state, rt_handle);
            return Ok(None);
        }
        let can_route_hook_management = builtin_action.is_some_and(|action| {
            matches!(
                action.handler,
                ActionHandler::NativeHooks | ActionHandler::ExternalHooks
            )
        }) && native_management_available;
        if can_route_hook_management {
            self.handle_hook_management(arguments, chat_view, chat_state, rt_handle);
            return Ok(None);
        }
        if external.is_none() && !unresolved_candidates.is_empty() && !native_choice_is_active {
            let choices = unresolved_candidates
                .iter()
                .map(|candidate| {
                    if candidate.restricted {
                        format!("{} (restricted)", candidate.description)
                    } else {
                        candidate.description.clone()
                    }
                })
                .collect::<Vec<_>>();
            chat_state.add_system_message(format!(
                "Command /{command_name} is provided by multiple sources: {}. Type /{command_name} and choose the source-labelled candidate from the slash-command picker. The choice is remembered until a participant changes.",
                choices.join(", ")
            ));
            return Ok(None);
        }
        match route {
            CommandRoute::Builtin => {
                let action = builtin_action.expect("route requires an available built-in action");
                if action.handler == ActionHandler::Reload {
                    return self.handle_reload_invocation(
                        reload_invocation.expect("reload action requires a parsed invocation"),
                        chat_view,
                        chat_state,
                        rt_handle,
                    );
                }
                self.dispatch_action(
                    action,
                    self.action_state(chat_state.is_processing, false),
                    chat_view,
                    chat_state,
                    rt_handle,
                )
            }
            CommandRoute::External => match self.handle_external_command(
                command_name,
                arguments,
                external.as_ref(),
                chat_view,
                chat_state,
                rt_handle,
            ) {
                Ok(result) => Ok(result),
                Err(error) if error.to_string().contains("command not found") => {
                    let message = removed_management_command_hint(parts[0], ActionContext::Chat)
                        .map(str::to_string)
                        .unwrap_or_else(|| {
                            format!(
                                "Unknown command: {}\nUse /help or type / to see available commands",
                                parts[0]
                            )
                        });
                    chat_state.add_system_message(message);
                    Ok(None)
                }
                Err(error) => Err(error),
            },
            CommandRoute::AskForCollisionChoice => {
                let reason = if builtin_reconfirmation_required {
                    "the previous external candidate changed or was removed"
                } else {
                    "OpenBitFun and an external source both provide it"
                };
                chat_state.add_system_message(format!(
                    "Command /{command_name} needs a source choice because {reason}. Type /{command_name} and choose the source-labelled candidate from the slash-command picker; the choice is remembered until a participant changes."
                ));
                Ok(None)
            }
            CommandRoute::WaitForDiscovery => {
                chat_state.add_system_message(format!(
                    "OpenBitFun is still checking compatible external commands. Retry /{command_name} when discovery finishes."
                ));
                Ok(None)
            }
        }
    }

    fn handle_reload_invocation(
        &mut self,
        target: std::result::Result<
            openbitfun_runtime_ports::AgentContextReloadTarget,
            &'static str,
        >,
        chat_view: &mut ChatView,
        chat_state: &mut ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) -> Result<Option<ChatExitReason>> {
        match target {
            Ok(target) => self.reload_context(target, chat_view, chat_state, rt_handle),
            Err(usage) => {
                chat_view.set_status(Some(usage.to_string()));
                chat_state.add_system_message(usage.to_string());
            }
        }
        Ok(None)
    }

    fn external_command_projection(&self, command_name: &str) -> Option<ExternalCommandProjection> {
        external_command_projections(
            self.external_source_snapshot.as_ref()?,
            &self.external_source_conflict_choices,
        )
        .into_iter()
        .find(|command| {
            command.provider_conflict_key.is_none()
                && command.command_name.eq_ignore_ascii_case(command_name)
        })
    }

    fn external_command_projection_for_action(
        &self,
        action_id: &str,
    ) -> Option<ExternalCommandProjection> {
        external_command_projections(
            self.external_source_snapshot.as_ref()?,
            &self.external_source_conflict_choices,
        )
        .into_iter()
        .find(|command| command.action_id == action_id)
    }

    fn external_conflict_projections(&self, command_name: &str) -> Vec<ExternalCommandProjection> {
        self.external_source_snapshot
            .as_ref()
            .map(|snapshot| {
                external_command_projections(snapshot, &self.external_source_conflict_choices)
                    .into_iter()
                    .filter(|command| {
                        command.provider_conflict_key.is_some()
                            && command.command_name.eq_ignore_ascii_case(command_name)
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    fn native_command_collision_for_action(
        &self,
        action_id: &str,
        command_name: Option<&str>,
    ) -> Option<ExternalCommandProjection> {
        external_command_projections(
            self.external_source_snapshot.as_ref()?,
            &self.external_source_conflict_choices,
        )
        .into_iter()
        .find(|command| {
            command
                .native_collision
                .as_ref()
                .is_some_and(|collision| collision.native_action_id == action_id)
                && command_name
                    .map(|name| command.command_name.eq_ignore_ascii_case(name))
                    .unwrap_or(true)
        })
    }

    fn remember_native_command_choice(
        &mut self,
        native_action_id: &str,
        command_name: &str,
        candidate_id: &str,
        chat_view: &mut ChatView,
        rt_handle: &tokio::runtime::Handle,
    ) {
        if action_by_id(native_action_id, ActionContext::Chat).is_none() {
            chat_view.set_status(Some(
                "The OpenBitFun command changed; reopen the command picker and retry".to_string(),
            ));
            return;
        }
        let native_commands = cli_native_prompt_command_descriptors(command_name);
        let expected_preference_revision = self
            .external_source_snapshot
            .as_ref()
            .map(|snapshot| snapshot.preference_revision)
            .unwrap_or(0);
        let persisted = tokio::task::block_in_place(|| {
            rt_handle.block_on(async {
                let workspace = self.agent.workspace_id();
                let conflicts =
                    openbitfun_core::external_sources::set_native_prompt_command_conflict_choice(
                        workspace.as_deref(),
                        native_commands,
                        candidate_id,
                        expected_preference_revision,
                    )
                    .await
                    .map_err(
                        openbitfun_core::external_sources::sanitize_external_source_operation_error,
                    )?;
                let preferences = openbitfun_core::external_sources::external_source_conflict_choices()
                    .await
                    .map(ExternalSourceConflictPreferences::from)
                    .map_err(
                        openbitfun_core::external_sources::sanitize_external_source_operation_error,
                    )?;
                Ok::<_, ExternalSourceOperationError>((conflicts, preferences))
            })
        });
        match persisted {
            Ok((conflicts, preferences)) => {
                self.replace_external_conflict_preferences(preferences);
                if let Some(snapshot) = &mut self.external_source_snapshot {
                    snapshot.preference_revision = conflicts.preference_revision;
                }
            }
            Err(error) => {
                tracing::warn!(
                    "Failed to persist native command conflict choice: {}",
                    error
                );
                chat_view.set_status(Some(
                    "The command choice could not be saved; this explicit command will run once"
                        .to_string(),
                ));
            }
        }
        if let Some(snapshot) = &self.external_source_snapshot {
            self.update_external_source_view(chat_view, snapshot);
        }
    }

    fn select_and_handle_external_command(
        &mut self,
        projection: &ExternalCommandProjection,
        arguments: &str,
        chat_view: &mut ChatView,
        chat_state: &mut ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) -> Result<Option<ChatExitReason>> {
        if projection.restricted {
            chat_state.add_system_message(format!(
                "External command {} is currently restricted and cannot be selected.",
                projection.invocation_alias
            ));
            return Ok(None);
        }
        if let Some(provider_conflict_key) = &projection.provider_conflict_key {
            let expected_preference_revision = self
                .external_source_snapshot
                .as_ref()
                .map(|snapshot| snapshot.preference_revision)
                .unwrap_or(0);
            let snapshot = tokio::task::block_in_place(|| {
                rt_handle.block_on(async {
                    let workspace = self.agent.workspace_id();
                    openbitfun_core::external_sources::set_external_prompt_command_conflict_choice(
                        workspace.as_deref(),
                        provider_conflict_key,
                        &projection.candidate_id,
                        expected_preference_revision,
                    )
                    .await
                    .map_err(
                        openbitfun_core::external_sources::sanitize_external_source_operation_error,
                    )
                    .map(ExternalSourceCatalogSnapshot::from)
                })
            });
            let snapshot = match snapshot {
                Ok(snapshot) => snapshot,
                Err(error) => {
                    chat_state.add_system_message(format!(
                        "Could not select {}: {error}",
                        projection.invocation_alias
                    ));
                    return Ok(None);
                }
            };
            self.external_source_snapshot = Some(snapshot);
            let Some(active) = self.external_command_projection(&projection.command_name) else {
                chat_state.add_system_message(format!(
                    "Selected external command /{} is no longer available; refresh and choose again.",
                    projection.command_name
                ));
                return Ok(None);
            };
            if let Some(collision) = &active.native_collision {
                self.remember_native_command_choice(
                    &collision.native_action_id,
                    &active.command_name,
                    &active.candidate_id,
                    chat_view,
                    rt_handle,
                );
            }
            if let Some(snapshot) = &self.external_source_snapshot {
                self.update_external_source_view(chat_view, snapshot);
            }
            return self.handle_external_command(
                &projection.command_name,
                arguments,
                Some(&active),
                chat_view,
                chat_state,
                rt_handle,
            );
        }
        if let Some(collision) = &projection.native_collision {
            self.remember_native_command_choice(
                &collision.native_action_id,
                &projection.command_name,
                &projection.candidate_id,
                chat_view,
                rt_handle,
            );
        }
        self.handle_external_command(
            &projection.command_name,
            arguments,
            Some(projection),
            chat_view,
            chat_state,
            rt_handle,
        )
    }

    fn handle_external_command(
        &mut self,
        command_name: &str,
        arguments: &str,
        expected: Option<&ExternalCommandProjection>,
        chat_view: &mut ChatView,
        chat_state: &mut ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) -> Result<Option<ChatExitReason>> {
        if chat_state.is_processing {
            chat_view.set_status(Some(
                "External prompt commands are unavailable while a turn is processing".to_string(),
            ));
            return Ok(None);
        }
        let native_commands = cli_native_prompt_command_descriptors(command_name);
        let native_conflict_key = expected
            .and_then(|command| command.native_collision.as_ref())
            .map(|collision| collision.conflict_key.as_str());
        let expected_preference_revision = native_conflict_key
            .and(self.external_source_snapshot.as_ref())
            .map(|snapshot| snapshot.preference_revision);
        self.invoke_external_prompt_command(
            ExternalPromptCommandInvocation {
                command_name: command_name.to_string(),
                arguments: arguments.to_string(),
                native_commands,
                candidate_id: expected.map(|command| command.candidate_id.clone()),
                content_version: expected.map(|command| command.content_version.clone()),
                native_conflict_key: native_conflict_key.map(str::to_string),
                expected_preference_revision,
            },
            None,
            chat_view,
            chat_state,
            rt_handle,
        )
    }

    fn invoke_external_prompt_command(
        &mut self,
        invocation: ExternalPromptCommandInvocation,
        shell_review_decision: Option<PromptCommandShellReviewDecision>,
        chat_view: &mut ChatView,
        chat_state: &mut ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) -> Result<Option<ChatExitReason>> {
        let expanded = tokio::task::block_in_place(|| {
            rt_handle.block_on(async {
                let workspace = self.agent.workspace_id();
                openbitfun_core::external_sources::expand_external_prompt_command(
                    workspace.as_deref(),
                    &invocation.command_name,
                    &invocation.arguments,
                    invocation.native_commands.clone(),
                    invocation.candidate_id.as_deref(),
                    invocation.content_version.as_deref(),
                    invocation.native_conflict_key.as_deref(),
                    invocation.expected_preference_revision,
                    shell_review_decision.as_ref(),
                )
                .await
                .map_err(
                    openbitfun_core::external_sources::sanitize_external_source_operation_error,
                )
            })
        });
        match expanded {
            Ok(PromptCommandInvocationOutcome::Ready {
                content,
                execution_target,
            }) => {
                match execution_target {
                    PromptCommandExecutionTarget::Inline => {
                        self.send_message_to_agent(content, chat_view, chat_state, rt_handle);
                    }
                    PromptCommandExecutionTarget::FreshExternalSubagent {
                        ecosystem_id,
                        logical_id,
                    } => {
                        let original_command = if invocation.arguments.trim().is_empty() {
                            format!("/{}", invocation.command_name)
                        } else {
                            format!("/{} {}", invocation.command_name, invocation.arguments)
                        };
                        self.send_external_subagent_command_to_agent(
                            content,
                            original_command,
                            ecosystem_id.to_string(),
                            logical_id,
                            chat_view,
                            chat_state,
                            rt_handle,
                        );
                    }
                }
                Ok(None)
            }
            Ok(PromptCommandInvocationOutcome::ReviewRequired { review }) => {
                chat_view.show_prompt_command_shell_review(review.clone());
                self.pending_prompt_command_shell_invocation =
                    Some(PendingPromptCommandShellInvocation { invocation, review });
                Ok(None)
            }
            Err(error) if error.detail.contains("command not found") => Err(anyhow!(error.detail)),
            Err(error) => {
                chat_state.add_system_message(format!(
                    "External command /{} is unavailable: {error}",
                    invocation.command_name
                ));
                Ok(None)
            }
        }
    }

    fn persist_presentation_preference(
        &mut self,
        chat_view: &mut ChatView,
        status: &str,
        update: impl FnOnce(&mut crate::config::CliConfig),
    ) {
        match self.config.update(update) {
            Ok(()) => chat_view.set_status(Some(status.to_string())),
            Err(error) => chat_view.set_status(Some(format!(
                "{status} for this run, but the preference could not be saved: {error}"
            ))),
        }
    }

    fn dispatch_action(
        &mut self,
        action: &'static ActionSpec,
        state: ActionState,
        chat_view: &mut ChatView,
        chat_state: &mut ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) -> Result<Option<ChatExitReason>> {
        if !action.available(state) {
            chat_view.set_status(Some(action.unavailable_message(state)));
            return Ok(None);
        }
        if pending_workspace_diff_blocks_runtime_action(
            self.agent.is_shared(),
            self.pending_workspace_diff.is_some(),
            action.handler,
        ) {
            chat_view.set_status(Some(
                "Waiting for the workspace diff to finish before using the Runtime again."
                    .to_string(),
            ));
            return Ok(None);
        }
        let pending_for_current_session = self
            .pending_session_operation
            .as_ref()
            .is_some_and(|pending| pending.session_id == chat_state.core_session_id);
        if pending_session_operation_blocks_runtime_action(
            self.agent.is_shared(),
            pending_for_current_session,
            action.handler,
        ) {
            chat_view.set_status(Some(format!(
                "Waiting for the pending Session operation to finish before using {}.",
                action.name
            )));
            return Ok(None);
        }
        match action.handler {
            ActionHandler::Help => {
                let mut help = self.keymap.help_text(state);
                help.push_str("\n\n");
                help.push_str(&session_command_help_note());
                if self.agent.is_shared() {
                    help.push_str("\n\n");
                    help.push_str(SHARED_TUI_HELP_NOTE);
                }
                chat_view.show_info_popup(help);
            }
            ActionHandler::OpenAgentSelector => {
                self.show_agent_selector(chat_view, chat_state, rt_handle);
            }
            ActionHandler::SwitchAgent => {
                self.cycle_agent(chat_view, chat_state, rt_handle);
            }
            ActionHandler::SwitchAgentReverse => {
                self.cycle_agent_reverse(chat_view, chat_state, rt_handle);
            }
            ActionHandler::SelectModel => {
                self.show_model_selector(chat_view, chat_state, rt_handle);
            }
            ActionHandler::SelectTheme => {
                let themes = self.list_available_themes();
                chat_view.begin_theme_preview();
                chat_view.show_theme_selector(themes, Some(self.config.ui.theme_id.clone()));
                chat_view.set_status(Some(
                    "Theme selector: ↑↓ preview, Enter apply, Esc cancel".to_string(),
                ));
            }
            ActionHandler::AddModel => {
                match tokio::task::block_in_place(|| {
                    rt_handle.block_on(async {
                        if self.agent.is_remote_workspace() {
                            anyhow::bail!("Model management is unavailable for a Remote workspace")
                        }
                        let catalog = openbitfun_core::get_ai_model_catalog()
                            .await
                            .map_err(anyhow::Error::msg)?;
                        Ok::<_, anyhow::Error>(crate::model_selection::model_catalog_projection(
                            catalog,
                        ))
                    })
                }) {
                    Ok(catalog) => chat_view.show_provider_selector(catalog.provider_catalog),
                    Err(error) => chat_view
                        .set_status(Some(format!("Failed to load model providers: {error}"))),
                }
            }
            ActionHandler::NewSession => {
                return Ok(Some(ChatExitReason::NewSession));
            }
            ActionHandler::Sessions => {
                self.show_session_selector(chat_view, chat_state, rt_handle);
            }
            ActionHandler::ViewSubagents => {
                self.show_session_lineage(chat_view, chat_state, rt_handle);
            }
            ActionHandler::Timeline => {
                let points = self
                    .displayed_chat_state(chat_state)
                    .session_timeline_points();
                if points.is_empty() {
                    chat_view.set_status(Some(
                        "No user messages are available in the current timeline".to_string(),
                    ));
                } else {
                    chat_view.show_timeline_selector(points);
                }
            }
            ActionHandler::ForkSession => {
                self.show_fork_selector(chat_view, chat_state);
            }
            ActionHandler::UndoSession => {
                self.revert_session(true, chat_view, chat_state, rt_handle);
            }
            ActionHandler::RedoSession => {
                self.revert_session(false, chat_view, chat_state, rt_handle);
            }
            ActionHandler::RenameSession => {
                return self.start_session_rename("", chat_view, chat_state, rt_handle);
            }
            ActionHandler::Skills => {
                self.show_skill_selector(chat_view, chat_state, rt_handle);
            }
            ActionHandler::Reload => {
                self.reload_context(
                    openbitfun_runtime_ports::AgentContextReloadTarget::All,
                    chat_view,
                    chat_state,
                    rt_handle,
                );
            }
            ActionHandler::McpServers => {
                self.show_mcp_selector(chat_view, chat_state, rt_handle);
            }
            ActionHandler::Tools => {
                self.handle_external_tool_review("", chat_view, chat_state, rt_handle);
            }
            ActionHandler::Extensions => {
                self.handle_external_control("", chat_view, chat_state, rt_handle);
            }
            ActionHandler::NativeHooks | ActionHandler::ExternalHooks => {
                self.handle_hook_management("", chat_view, chat_state, rt_handle);
            }
            ActionHandler::AcpHelp => {
                chat_state.add_system_message(crate::acp_cli::acp_help_text("openbitfun"));
                chat_view.set_status(Some(
                    "ACP setup added to the conversation. You can keep typing.".to_string(),
                ));
            }
            ActionHandler::Init => match crate::prompts::get_cli_prompt("init") {
                Some(prompt) => {
                    self.send_message_to_agent(prompt.to_string(), chat_view, chat_state, rt_handle)
                }
                None => chat_state.add_system_message(
                    "Init prompt not found. Please create prompts/init.md in the CLI crate."
                        .to_string(),
                ),
            },
            ActionHandler::Status => {
                chat_view.show_info_popup(session_status_text(chat_state, self.agent.is_shared()));
            }
            ActionHandler::WorkspaceDiff => {
                if self.pending_workspace_diff.is_some() {
                    chat_view.set_status(Some(
                        "Workspace diff is already loading. Please wait.".to_string(),
                    ));
                    return Ok(None);
                }
                chat_view.set_status(Some("Loading workspace diff...".to_string()));
                let agent = self.agent.clone();
                let handle = rt_handle.spawn(async move {
                    agent
                        .workspace_diff()
                        .await
                        .map_err(|error| error.to_string())
                });
                self.pending_workspace_diff = Some(PendingWorkspaceDiff { handle });
            }
            ActionHandler::CompactSession => {
                self.start_session_compaction(chat_view, chat_state, rt_handle);
            }
            ActionHandler::Usage => self.show_usage_report(chat_view, chat_state, rt_handle),
            ActionHandler::Editor => match external_editor::resolve_editor_command() {
                Ok(command) => {
                    self.pending_local_effect = Some(PendingLocalEffect::EditComposer {
                        command,
                        draft: chat_view.draft_snapshot(),
                    });
                    chat_view.set_status(Some("Opening external editor...".to_string()));
                }
                Err(error) => chat_view.set_status(Some(format!("Editor unavailable: {error}"))),
            },
            ActionHandler::PromptStash => self.stash_current_prompt(chat_view),
            ActionHandler::PromptStashPop => self.pop_prompt_stash(chat_view),
            ActionHandler::PromptStashList => self.show_prompt_stash(chat_view),
            ActionHandler::ToggleTimestamps => {
                let visible = chat_view.toggle_timestamps();
                self.persist_presentation_preference(
                    chat_view,
                    if visible {
                        "Message timestamps shown"
                    } else {
                        "Message timestamps hidden"
                    },
                    |config| config.ui.timestamps = visible,
                );
            }
            ActionHandler::ToggleThinking => {
                let mode = chat_view.toggle_thinking();
                self.persist_presentation_preference(
                    chat_view,
                    match mode {
                        crate::config::ThinkingMode::Show => "Thinking blocks shown",
                        crate::config::ThinkingMode::Hide => "Thinking blocks hidden",
                    },
                    |config| config.ui.thinking = mode,
                );
            }
            ActionHandler::ToggleToolDetails => {
                let visible = chat_view.toggle_tool_details();
                self.persist_presentation_preference(
                    chat_view,
                    if visible {
                        "Tool details shown"
                    } else {
                        "Tool details hidden"
                    },
                    |config| config.ui.tool_details = visible,
                );
            }
            ActionHandler::CopyTranscript => {
                let markdown = transcript::render_session_markdown(
                    self.displayed_chat_state(chat_state),
                    transcript::MarkdownTranscriptOptions::default(),
                );
                let provider = openbitfun_services_core::system::LocalSystemProvider::new();
                match tokio::task::block_in_place(|| {
                    rt_handle.block_on(provider.clipboard_write_text(&markdown))
                }) {
                    Ok(()) => chat_view.set_status(Some(
                        "Copied the current session transcript as Markdown".to_string(),
                    )),
                    Err(error) => {
                        let hints = if error.hints().is_empty() {
                            String::new()
                        } else {
                            format!(" ({})", error.hints().join("; "))
                        };
                        chat_view.set_status(Some(format!(
                            "Could not copy the transcript: {}{hints}",
                            error.message()
                        )));
                    }
                }
            }
            ActionHandler::ExportTranscript => {
                let displayed = self.displayed_chat_state(chat_state);
                chat_view.show_export_dialog(transcript::default_export_filename(
                    &displayed.core_session_id,
                ));
                chat_view.set_status(Some(
                    "Choose what to include in the Markdown export".to_string(),
                ));
            }
            ActionHandler::ToggleAutoApprove => {}
            ActionHandler::ToggleWorktree => {
                return self.handle_worktree_command("", chat_view, chat_state, rt_handle);
            }
            ActionHandler::Exit => {
                if chat_state.is_processing {
                    self.cancel_active_turn(chat_view, rt_handle);
                    if self.agent.is_shared() {
                        return Ok(None);
                    }
                }
                return Ok(Some(ChatExitReason::Quit));
            }
            ActionHandler::Login => {
                self.close_all_popups(chat_view);
                self.open_login_or_account_panel(chat_view, chat_state, rt_handle);
            }
            ActionHandler::Logout => self.logout(chat_state, rt_handle),
            ActionHandler::OpenPalette => chat_view.show_command_palette(state),
            ActionHandler::SubmitInput => {
                return self.submit_input(chat_view, chat_state, rt_handle);
            }
            ActionHandler::Interrupt => {
                if self.lineage_inspection.is_some() {
                    self.cancel_inspected_lineage_session(chat_view, rt_handle);
                } else {
                    self.cancel_active_turn(chat_view, rt_handle);
                }
            }
            ActionHandler::ClosePopups => self.close_all_popups(chat_view),
            ActionHandler::NavigateBack => {
                if self.lineage_inspection.is_some() && !state.popup_open {
                    self.leave_lineage_inspection(chat_view);
                } else {
                    self.navigate_back(chat_view);
                }
            }
            ActionHandler::InsertNewline => {
                chat_view.handle_newline();
                self.sync_selected_native_command(chat_view);
            }
            ActionHandler::Paste => self.paste_clipboard(chat_view),
            ActionHandler::ToggleFocusedTool => {
                chat_view.toggle_focused_tool_expand(self.displayed_chat_state(chat_state));
            }
            ActionHandler::PreviousTool => {
                chat_view.cycle_block_tool_focus_prev(self.displayed_chat_state(chat_state));
            }
            ActionHandler::NextTool => {
                chat_view.cycle_block_tool_focus_next(self.displayed_chat_state(chat_state));
            }
            ActionHandler::HistoryPrevious => {
                if chat_view.command_menu_visible() {
                    chat_view.command_menu_up();
                } else {
                    chat_view.history_prev();
                    self.selected_native_command_once = None;
                }
            }
            ActionHandler::HistoryNext => {
                if chat_view.command_menu_visible() {
                    chat_view.command_menu_down();
                } else {
                    chat_view.history_next();
                    self.selected_native_command_once = None;
                }
            }
            ActionHandler::JumpTop => {
                let total = chat_view.count_message_lines(self.displayed_chat_state(chat_state));
                chat_view.scroll_to_top(total);
                chat_view.set_status(Some("Jumped to conversation top".to_string()));
            }
            ActionHandler::JumpBottom => {
                chat_view.scroll_to_bottom();
                chat_view.set_status(Some("Jumped to conversation bottom".to_string()));
            }
            ActionHandler::ClearInput => {
                chat_view.clear_input();
                self.selected_native_command_once = None;
            }
            ActionHandler::ToggleBrowse => {
                chat_view.toggle_browse_mode();
                let status = if chat_view.browse_mode {
                    "Entered browse mode, use PageUp/PageDown or mouse wheel to scroll conversation"
                } else {
                    "Exited browse mode"
                };
                chat_view.set_status(Some(status.to_string()));
            }
            ActionHandler::ScrollUp => {
                let total = chat_view.count_message_lines(self.displayed_chat_state(chat_state));
                chat_view.scroll_up(10, total);
            }
            ActionHandler::ScrollDown => chat_view.scroll_down(10),
        }
        Ok(None)
    }

    fn prepare_transcript_export(
        &mut self,
        request: crate::ui::export_dialog::ExportDialogRequest,
        overwrite_confirmed: bool,
        chat_view: &mut ChatView,
        markdown: String,
    ) {
        let target = if request.save_to_file {
            let target = match transcript::resolve_export_target(&self.local_cwd, &request.filename)
            {
                Ok(target) => target,
                Err(error) => {
                    chat_view.export_dialog_set_error(error.to_string());
                    return;
                }
            };
            if target.is_dir() {
                chat_view.export_dialog_set_error(format!(
                    "Export target is a directory: {}",
                    target.display()
                ));
                return;
            }
            if target.exists() && !overwrite_confirmed {
                chat_view.export_dialog_confirm_overwrite(target.display().to_string());
                return;
            }
            Some(target)
        } else {
            None
        };

        let (editor_command, editor_error) = if request.open_in_editor {
            match external_editor::resolve_editor_command() {
                Ok(command) => (Some(command), None),
                Err(error) if request.save_to_file => (None, Some(error.to_string())),
                Err(error) => {
                    chat_view
                        .export_dialog_set_error(format!("Cannot open an unsaved export: {error}"));
                    return;
                }
            }
        } else {
            (None, None)
        };

        chat_view.set_status(Some("Exporting session transcript...".to_string()));
        self.pending_local_effect = Some(PendingLocalEffect::ExportTranscript {
            markdown,
            target,
            editor_command,
            editor_error,
            overwrite_confirmed,
        });
    }

    fn start_session_compaction(
        &self,
        chat_view: &mut ChatView,
        chat_state: &ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) {
        let agent = self.agent.clone();
        let session_id = chat_state.core_session_id.clone();
        chat_view.set_status(Some("Compacting context...".to_string()));
        let result = tokio::task::block_in_place(|| {
            rt_handle.block_on(async move { agent.start_session_compaction(&session_id).await })
        });
        if let Err(error) = result {
            chat_view.set_status(Some(format!("Could not compact context: {error}")));
        }
    }

    fn revert_session(
        &mut self,
        undo: bool,
        chat_view: &mut ChatView,
        chat_state: &mut ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) {
        let operation = if undo { "Undo" } else { "Redo" };
        chat_view.set_status(Some(format!("{operation}ing session...")));
        let agent = self.agent.clone();
        let restored_workspace_references = if undo {
            if let Some(message_id) = chat_state.latest_user_message_id() {
                let session_id = chat_state.core_session_id.clone();
                match tokio::task::block_in_place(|| {
                    rt_handle
                        .block_on(agent.workspace_references_for_message(session_id, message_id))
                }) {
                    Ok(references) => Some(references),
                    Err(error) => {
                        chat_view.set_status(Some(format!(
                            "Could not prepare undo composer metadata: {error}"
                        )));
                        return;
                    }
                }
            } else {
                None
            }
        } else {
            None
        };
        let agent = self.agent.clone();
        let result = tokio::task::block_in_place(|| {
            rt_handle.block_on(async move { agent.revert_current_session(undo).await })
        });
        let reverted = match result {
            Ok(reverted) => reverted,
            Err(error) => {
                chat_view.set_status(Some(format!(
                    "Could not {} session: {error}",
                    operation.to_ascii_lowercase()
                )));
                return;
            }
        };

        chat_state.replace_from_authoritative_transcript(
            &reverted.transcript,
            &reverted.retired_turn_ids,
        );
        if !undo && reverted.changed {
            chat_view.note_session_redo(&chat_state.core_session_id);
        }
        match reverted.composer {
            AgentSessionComposerUpdate::Preserve => {}
            AgentSessionComposerUpdate::Replace { text } => {
                let references = restored_workspace_references.unwrap_or_default();
                let draft = if undo && reverted.changed {
                    chat_view.restore_undo_draft(&chat_state.core_session_id, text, references)
                } else {
                    crate::ui::composer::ComposerDraft {
                        text,
                        workspace_references: references,
                        ..crate::ui::composer::ComposerDraft::default()
                    }
                };
                chat_view.set_draft(draft)
            }
            AgentSessionComposerUpdate::Clear => chat_view.clear_input(),
        }
        self.selected_native_command_once = None;
        chat_view.clear_screen();
        chat_view.scroll_to_bottom();
        chat_view.set_status(Some(if reverted.changed {
            if undo {
                format!(
                    "Undid the latest prompt; {} persisted turn(s) are hidden.",
                    reverted.hidden_turn_count
                )
            } else if reverted.hidden_turn_count == 0 {
                "Restored the full session history.".to_string()
            } else {
                format!(
                    "Redid session history; {} persisted turn(s) remain hidden.",
                    reverted.hidden_turn_count
                )
            }
        } else if undo {
            "Nothing to undo.".to_string()
        } else {
            "Nothing to redo.".to_string()
        }));
    }

    fn poll_workspace_diff(&mut self, chat_view: &mut ChatView) -> bool {
        let Some(pending) = self.pending_workspace_diff.as_ref() else {
            return false;
        };
        if !pending.handle.is_finished() {
            return false;
        }
        let pending = self
            .pending_workspace_diff
            .take()
            .expect("workspace diff task was checked above");
        match tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(pending.handle)
        }) {
            Ok(Ok(snapshot)) => {
                self.close_all_popups(chat_view);
                chat_view.show_workspace_diff(snapshot);
                chat_view.set_status(None);
            }
            Ok(Err(error)) => {
                chat_view.set_status(Some(format!("Unable to load workspace diff: {error}")));
            }
            Err(error) => {
                chat_view.set_status(Some(format!("Workspace diff loading stopped: {error}")));
            }
        }
        true
    }

    fn start_session_rename(
        &mut self,
        arguments: &str,
        chat_view: &mut ChatView,
        chat_state: &mut ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) -> Result<Option<ChatExitReason>> {
        let Some(session_name) = requested_session_name(arguments) else {
            chat_view.set_status(Some("Usage: /rename <name>".to_string()));
            return Ok(None);
        };
        if self.pending_session_operation.is_some() {
            chat_view.set_status(Some(
                "A Session operation is already in progress. Please wait.".to_string(),
            ));
            return Ok(None);
        }
        if session_name == chat_state.session_name {
            chat_view.set_status(Some(
                "The current session already uses that name.".to_string(),
            ));
            return Ok(None);
        }

        let session_id = chat_state.core_session_id.clone();
        let task_session_id = session_id.clone();
        let task_session_name = session_name.clone();
        let agent = self.agent.clone();
        chat_view.set_status(Some("Renaming current session...".to_string()));
        let handle = rt_handle.spawn(async move {
            agent
                .rename_session(&task_session_id, &task_session_name)
                .await
        });
        self.pending_session_operation = Some(PendingSessionOperation {
            session_id,
            kind: PendingSessionOperationKind::Rename { session_name },
            started_at: Instant::now(),
            slow_notice_shown: false,
            exit_warning_shown: false,
            handle,
        });
        Ok(None)
    }

    fn submit_input(
        &mut self,
        chat_view: &mut ChatView,
        chat_state: &mut ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) -> Result<Option<ChatExitReason>> {
        let shell_mode = chat_view.is_shell_mode();
        let draft_has_images = chat_view.draft_snapshot().has_images();
        if draft_has_images && chat_view.command_menu_visible() {
            chat_view.set_status(Some(IMAGE_ATTACHMENTS_REQUIRE_MESSAGE.to_string()));
            return Ok(None);
        }
        if let Some(selection) = chat_view.apply_command_menu_selection() {
            return self.handle_action_id(
                &selection.action_id,
                Some(&selection.command_name),
                chat_view,
                chat_state,
                rt_handle,
            );
        }

        let trimmed = chat_view.input_text().trim();
        if shell_mode && draft_has_images {
            chat_view.set_status(Some("Images are unavailable in Shell mode".to_string()));
            return Ok(None);
        }
        if !shell_mode && draft_has_images && trimmed.starts_with('/') {
            chat_view.set_status(Some(IMAGE_ATTACHMENTS_REQUIRE_MESSAGE.to_string()));
            return Ok(None);
        }
        if shell_mode || !trimmed.starts_with('/') {
            self.selected_native_command_once = None;
        }
        let pending_for_current_session = self
            .pending_session_operation
            .as_ref()
            .is_some_and(|pending| pending.session_id == chat_state.core_session_id);
        if (shell_mode && pending_for_current_session)
            || session_update_blocks_typed_submission(pending_for_current_session, trimmed)
        {
            chat_view.set_status(Some(
                "Waiting for the pending Session operation to finish before sending.".to_string(),
            ));
            return Ok(None);
        }

        if chat_state.is_processing {
            if !shell_mode && trimmed.starts_with('/') {
                if let Some(input) = chat_view.send_input() {
                    return self.handle_command(&input.text, chat_view, chat_state, rt_handle);
                }
            } else if shell_mode && !trimmed.is_empty() {
                chat_view.set_status(Some(
                    "Currently processing. Wait for the turn to finish or interrupt it."
                        .to_string(),
                ));
            } else if !trimmed.is_empty() {
                let draft = chat_view.draft_snapshot();
                if let Some(reason) = steering_unsupported_reason(&draft) {
                    chat_view.set_status(Some(reason.to_string()));
                } else if let Some(draft) = chat_view.send_input() {
                    self.steer_draft_to_agent(draft, chat_view, chat_state, rt_handle);
                }
            }
            return Ok(None);
        }

        if let Some(input) = chat_view.send_input() {
            if shell_mode {
                self.send_shell_command(input, chat_view, chat_state, rt_handle);
                return Ok(None);
            }
            tracing::info!("User input: {}", input.text);
            if input.text.starts_with('/') {
                return self.handle_command(&input.text, chat_view, chat_state, rt_handle);
            }
            self.send_draft_to_agent(input, chat_view, chat_state, rt_handle);
        }
        Ok(None)
    }

    fn steer_draft_to_agent(
        &mut self,
        draft: crate::ui::composer::ComposerDraft,
        chat_view: &mut ChatView,
        chat_state: &mut ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) {
        let agent = self.agent.clone();
        let result = tokio::task::block_in_place(|| {
            rt_handle
                .block_on(agent.steer_current_turn(draft.text.clone(), Some(draft.text.clone())))
        });
        match result {
            Ok(steering_id) => {
                tracing::info!(
                    "Steering submitted: turn_id={:?}, steering_id={}",
                    chat_state.current_turn_id(),
                    steering_id
                );
                chat_view.remember_submitted_draft(&chat_state.core_session_id, &draft);
                chat_state.handle_user_steering(&steering_id, &draft.text, true);
                chat_view.invalidate_lines_cache();
                let display_name = agent_display_name(&self.agent_type);
                chat_view.set_status(Some(format!("{} is thinking...", display_name)));
            }
            Err(error) => {
                tracing::error!("Failed to steer active turn: {error}");
                chat_view.set_status(Some(format!("Error: {error}")));
                chat_view.set_draft(draft);
            }
        }
    }

    fn send_shell_command(
        &mut self,
        draft: crate::ui::composer::ComposerDraft,
        chat_view: &mut ChatView,
        chat_state: &mut ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) {
        if let Err(error) = self.materialize_requested_worktree(chat_view, chat_state, rt_handle) {
            tracing::error!("Failed to prepare worktree for Shell command: {error}");
            chat_view.set_status(Some(format!("Error: {error}")));
            chat_state.add_system_message(error);
            chat_view.set_draft(draft);
            return;
        }

        chat_view.set_status(Some("Running Shell command...".to_string()));
        let agent = self.agent.clone();
        let agent_type = self.agent_type.clone();
        match tokio::task::block_in_place(|| {
            rt_handle.block_on(agent.run_user_shell_command(draft.text.clone(), &agent_type))
        }) {
            Ok(turn_id) => {
                tracing::info!("Started Shell turn: {}", turn_id);
                chat_view.remember_submitted_shell_command(&chat_state.core_session_id, &draft);
                chat_view.exit_shell_mode();
            }
            Err(error) => {
                tracing::error!("Failed to start Shell command: {error}");
                chat_view.set_status(Some(format!("Error: {error}")));
                chat_view.set_draft(draft);
            }
        }
    }

    fn cancel_active_turn(
        &self,
        chat_view: &mut ChatView,
        rt_handle: &tokio::runtime::Handle,
    ) -> bool {
        tracing::info!("User requested cancellation");
        let agent = self.agent.clone();
        let result = tokio::task::block_in_place(|| {
            rt_handle.block_on(async move { agent.cancel_current_turn().await })
        });
        match result {
            Ok(()) => {
                chat_view.set_status(Some(
                    "Cancelling... Wait for the turn to stop before retrying.".to_string(),
                ));
                true
            }
            Err(error) => {
                tracing::error!("Failed to cancel turn: {}", error);
                chat_view.set_status(Some(format!("Cancellation failed: {error}")));
                false
            }
        }
    }

    fn paste_clipboard(&mut self, chat_view: &mut ChatView) {
        match image_paste::read_clipboard(&self.local_cwd) {
            Ok(Some(paste)) => self.apply_composer_paste(paste, chat_view),
            Ok(None) => {}
            Err(error) => chat_view.set_status(Some(error.to_string())),
        }
    }

    fn paste_terminal_text(&mut self, text: &str, chat_view: &mut ChatView) {
        match image_paste::classify_pasted_text(text, &self.local_cwd) {
            Ok(paste) => self.apply_composer_paste(paste, chat_view),
            Err(error) => chat_view.set_status(Some(error.to_string())),
        }
    }

    fn apply_composer_paste(&mut self, paste: ImagePaste, chat_view: &mut ChatView) {
        match paste {
            ImagePaste::Text(text) => chat_view.insert_paste(&text),
            ImagePaste::Image(_) if chat_view.is_shell_mode() => {
                chat_view.set_status(Some("Images are unavailable in Shell mode".to_string()));
                return;
            }
            ImagePaste::Image(_image) if self.agent.is_shared() => {
                chat_view.set_status(Some(crate::actions::shared_tui_image_attachment_error()));
                return;
            }
            ImagePaste::Image(image) => {
                let name = image.name.clone();
                if let Err(error) = chat_view.insert_image(image) {
                    chat_view.set_status(Some(error.to_string()));
                    return;
                }
                chat_view.set_status(Some(format!("Attached image: {name}")));
            }
        }
        self.sync_selected_native_command(chat_view);
    }
}

fn action_opens_extension_management(action: &ActionSpec) -> bool {
    matches!(
        action.handler,
        ActionHandler::Tools
            | ActionHandler::Extensions
            | ActionHandler::ExternalHooks
            | ActionHandler::OpenAgentSelector
    )
}
