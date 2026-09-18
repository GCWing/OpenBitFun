fn parse_positive_index(value: Option<&str>, label: &str) -> Result<usize, String> {
    let raw = value.ok_or_else(|| format!("missing {label}"))?;
    let index = raw
        .parse::<usize>()
        .map_err(|_| format!("{label} must be a positive number"))?;
    if index == 0 {
        return Err(format!("{label} must be a positive number"));
    }
    Ok(index - 1)
}

fn parse_external_tool_review_action(
    arguments: &str,
    current_snapshot: Option<&ExternalSourceCatalogSnapshot>,
    reviewed_snapshot: Option<&ExternalSourceCatalogSnapshot>,
) -> Result<ExternalToolReviewAction, String> {
    let mut parts = arguments.split_whitespace();
    let Some(command) = parts.next() else {
        return Ok(ExternalToolReviewAction::Show);
    };
    if command.eq_ignore_ascii_case("refresh") {
        if parts.next().is_some() {
            return Err("usage: /tools refresh".to_string());
        }
        return Ok(ExternalToolReviewAction::Refresh);
    }
    if command.eq_ignore_ascii_case("help") {
        return Ok(ExternalToolReviewAction::Show);
    }
    // Numbered commands refer to the immutable catalog that produced the
    // review popup. The backend still validates stable decision/conflict keys,
    // so a changed target fails closed instead of reusing the same number for
    // a different tool after a watcher refresh.
    let snapshot = reviewed_snapshot.or(current_snapshot).ok_or_else(|| {
        "OpenBitFun has not finished checking external tools; run /tools refresh".to_string()
    })?;
    if command.eq_ignore_ascii_case("enable") || command.eq_ignore_ascii_case("disable") {
        let index = parse_positive_index(parts.next(), "tool number")?;
        if parts.next().is_some() {
            return Err(format!("usage: /tools {command} <tool-number>"));
        }
        let targets = external_tool_target_summaries(snapshot);
        let target = targets
            .get(index)
            .ok_or_else(|| "that tool is no longer available; run /tools refresh".to_string())?;
        let approved = command.eq_ignore_ascii_case("enable");
        let allowed = if approved {
            external_tool_can_enable(target.activation())
        } else {
            external_tool_can_disable(target.activation())
        };
        if !allowed {
            return Err(format!(
                "tool {} is {}; run /tools refresh for its next step",
                index + 1,
                external_tool_activation_label(target.activation())
            ));
        }
        let tool = target.first();
        return Ok(ExternalToolReviewAction::Decide {
            approval_key: tool.approval_key.clone(),
            decision_key: tool.decision_key.clone(),
            approved,
        });
    }
    if command.eq_ignore_ascii_case("choose") {
        let conflict_index = parse_positive_index(parts.next(), "conflict number")?;
        let candidate_index = parse_positive_index(parts.next(), "choice number")?;
        if parts.next().is_some() {
            return Err("usage: /tools choose <conflict-number> <choice-number>".to_string());
        }
        let conflict = snapshot
            .tool_conflicts
            .iter()
            .filter(|conflict| conflict.selected_candidate_id.is_none())
            .chain(
                snapshot
                    .tool_conflicts
                    .iter()
                    .filter(|conflict| conflict.selected_candidate_id.is_some()),
            )
            .nth(conflict_index)
            .ok_or_else(|| {
                "that conflict is no longer available; run /tools refresh".to_string()
            })?;
        let candidate = conflict
            .candidates
            .get(candidate_index)
            .ok_or_else(|| "that choice is no longer available; run /tools refresh".to_string())?;
        return Ok(ExternalToolReviewAction::Choose {
            conflict_key: conflict.conflict_key.clone(),
            candidate_id: candidate.candidate_id.clone(),
        });
    }
    Err("usage: /tools [refresh | enable <number> | disable <number> | choose <conflict-number> <choice-number>]".to_string())
}

fn external_tool_mutation_result_label(
    action: &ExternalToolReviewAction,
    snapshot: &ExternalSourceCatalogSnapshot,
) -> String {
    match action {
        ExternalToolReviewAction::Refresh => "External tools refreshed".to_string(),
        ExternalToolReviewAction::Decide {
            approval_key,
            decision_key,
            approved: true,
        } => {
            let activations = snapshot
                .tools
                .iter()
                .filter(|tool| {
                    tool.approval_key == *approval_key && tool.decision_key == *decision_key
                })
                .map(|tool| &tool.activation)
                .collect::<Vec<_>>();
            if activations.is_empty() {
                "External tool confirmation saved; run /tools refresh to review the changed tool"
                    .to_string()
            } else if activations
                .iter()
                .any(|state| matches!(state, ExternalToolActivationState::LoadFailed { .. }))
            {
                "External tool enabled, but loading failed".to_string()
            } else if activations.iter().any(|state| {
                matches!(
                    state,
                    ExternalToolActivationState::RuntimeUnavailable { .. }
                )
            }) {
                "External tool enabled, but its run environment is unavailable".to_string()
            } else if activations
                .iter()
                .any(|state| matches!(state, ExternalToolActivationState::Conflict))
            {
                "External tool enabled; choose a source before every tool is available".to_string()
            } else if activations
                .iter()
                .all(|state| matches!(state, ExternalToolActivationState::Active))
            {
                "External tool enabled".to_string()
            } else {
                "External tool confirmation saved; run /tools refresh to review its current state"
                    .to_string()
            }
        }
        ExternalToolReviewAction::Decide {
            approval_key,
            decision_key,
            approved: false,
        } => {
            let disabled = snapshot.tools.iter().any(|tool| {
                tool.approval_key == *approval_key
                    && tool.decision_key == *decision_key
                    && matches!(tool.activation, ExternalToolActivationState::Disabled)
            });
            if disabled {
                "External tool disabled".to_string()
            } else {
                "External tool choice saved; run /tools refresh to review the changed tool"
                    .to_string()
            }
        }
        ExternalToolReviewAction::Choose {
            conflict_key,
            candidate_id,
        } => {
            let selected = snapshot.tool_conflicts.iter().any(|conflict| {
                conflict.conflict_key == *conflict_key
                    && conflict.selected_candidate_id.as_deref() == Some(candidate_id.as_str())
            });
            if selected {
                "External tool source selected".to_string()
            } else {
                "External tool choices changed; run /tools refresh before choosing".to_string()
            }
        }
        ExternalToolReviewAction::Show => "External tools".to_string(),
    }
}

struct BuiltinCommandReconfirmation {
    command_name: String,
    candidate_id: String,
    confirmed: bool,
}

fn cli_native_prompt_command_descriptors(command_name: &str) -> Vec<NativePromptCommandDescriptor> {
    slash_actions(ActionState::chat(false, false))
        .into_iter()
        .filter(|action| {
            action
                .name
                .trim_start_matches('/')
                .eq_ignore_ascii_case(command_name)
        })
        .map(|action| NativePromptCommandDescriptor {
            command_name: command_name.to_ascii_lowercase(),
            candidate_id: format!("openbitfun.cli:{}", action.id),
            behavior_version: action_conflict_behavior_version(action.id).to_string(),
        })
        .collect()
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct ExternalSourceConflictPreferences {
    choices: BTreeMap<String, String>,
    lineage_current_keys: BTreeMap<String, String>,
    conflicted_candidate_ids: BTreeSet<String>,
}

impl
    From<(
        BTreeMap<String, String>,
        BTreeMap<String, String>,
        BTreeSet<String>,
    )> for ExternalSourceConflictPreferences
{
    fn from(
        (choices, lineage_current_keys, conflicted_candidate_ids): (
            BTreeMap<String, String>,
            BTreeMap<String, String>,
            BTreeSet<String>,
        ),
    ) -> Self {
        Self {
            choices,
            lineage_current_keys,
            conflicted_candidate_ids,
        }
    }
}

fn builtin_command_reconfirmation(
    action_id: &str,
    command_name: &str,
    preferences: &ExternalSourceConflictPreferences,
) -> Option<BuiltinCommandReconfirmation> {
    let candidate_id = format!("openbitfun.cli:{action_id}");
    let participated_in_conflict = preferences.conflicted_candidate_ids.contains(&candidate_id);
    if !participated_in_conflict {
        return None;
    }
    let command_name = command_name.trim_start_matches('/');
    let conflict_key = native_prompt_command_conflict_key(
        "local-user",
        command_name,
        [(
            candidate_id.as_str(),
            action_conflict_behavior_version(action_id),
        )],
    );
    let confirmed = preferences.choices.get(&conflict_key) == Some(&candidate_id);
    Some(BuiltinCommandReconfirmation {
        command_name: command_name.to_ascii_lowercase(),
        candidate_id,
        confirmed,
    })
}

fn builtin_reconfirmation_names(
    preferences: &ExternalSourceConflictPreferences,
) -> BTreeSet<String> {
    slash_actions(ActionState::chat(false, false))
        .into_iter()
        .filter(|action| {
            builtin_command_reconfirmation(action.id, action.name, preferences)
                .is_some_and(|reconfirmation| !reconfirmation.confirmed)
        })
        .map(|action| action.name.trim_start_matches('/').to_ascii_lowercase())
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CommandRoute {
    Builtin,
    External,
    AskForCollisionChoice,
    WaitForDiscovery,
}

fn command_route(
    has_builtin: bool,
    external: Option<&ExternalCommandProjection>,
    discovery_pending: bool,
    builtin_reconfirmation_required: bool,
) -> CommandRoute {
    if builtin_reconfirmation_required {
        return CommandRoute::AskForCollisionChoice;
    }
    if let Some(collision) = external.and_then(|command| command.native_collision.as_ref()) {
        return match collision.selected_candidate_id.as_deref() {
            Some(selected) if selected == collision.external_candidate_id => CommandRoute::External,
            Some(selected) if selected == collision.native_candidate_id => CommandRoute::Builtin,
            _ => CommandRoute::AskForCollisionChoice,
        };
    }
    if has_builtin {
        CommandRoute::Builtin
    } else if discovery_pending {
        CommandRoute::WaitForDiscovery
    } else {
        CommandRoute::External
    }
}

impl ChatMode {
    fn external_conflict_preferences(&self) -> ExternalSourceConflictPreferences {
        ExternalSourceConflictPreferences {
            choices: self.external_source_conflict_choices.clone(),
            lineage_current_keys: self.external_source_conflict_lineage_current_keys.clone(),
            conflicted_candidate_ids: self.external_source_conflicted_candidate_ids.clone(),
        }
    }

    fn update_external_source_view(
        &self,
        chat_view: &mut ChatView,
        snapshot: &ExternalSourceCatalogSnapshot,
    ) {
        let preferences = self.external_conflict_preferences();
        chat_view.set_external_source_state(
            external_command_projections(snapshot, &preferences.choices),
            snapshot.discovery_pending,
            builtin_reconfirmation_names(&preferences),
        );
    }

    fn take_external_tool_notice(
        &mut self,
        snapshot: &ExternalSourceCatalogSnapshot,
    ) -> Option<String> {
        let next_key = external_tool_pending_notice_key(snapshot);
        if next_key == self.external_tool_notice_key {
            return None;
        }
        self.external_tool_notice_key = next_key;
        let approvals = snapshot.tool_approval_requests.len();
        let conflicts = snapshot
            .tool_conflicts
            .iter()
            .filter(|conflict| conflict.selected_candidate_id.is_none())
            .count();
        let diagnostics = snapshot
            .diagnostics
            .iter()
            .filter(|diagnostic| {
                matches!(
                    diagnostic.severity,
                    ExternalSourceDiagnosticSeverity::Warning
                        | ExternalSourceDiagnosticSeverity::Error
                )
            })
            .count();
        if approvals + conflicts + diagnostics == 0 {
            None
        } else {
            Some(format!(
                "Tools from external AI applications need attention: {approvals} approvals, {conflicts} name conflicts, {diagnostics} diagnostics - run /tools refresh"
            ))
        }
    }

    fn handle_external_control(
        &mut self,
        arguments: &str,
        chat_view: &mut ChatView,
        _chat_state: &ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) {
        let action = match parse_external_control_action(arguments) {
            Ok(action) => action,
            Err(error) => {
                chat_view.set_status(Some(error));
                return;
            }
        };
        if self.external_control_mutation_rx.is_some() {
            chat_view.set_status(Some(
                "An extension update is already running; input remains available.".to_string(),
            ));
            return;
        }

        let source_selection = match &action {
            ExternalControlUiAction::SetSourceEnabled {
                source_index,
                enabled,
            } => {
                let Some(control) = self.external_control_snapshot.as_ref() else {
                    chat_view.set_status(Some(
                        "Open /extensions before changing an extension.".to_string(),
                    ));
                    return;
                };
                if !control.host_capabilities.can_manage_sources {
                    chat_view.set_status(Some(
                        "This connection can only show extension status.".to_string(),
                    ));
                    return;
                }
                let Some(source) = control.sources.get(*source_index) else {
                    chat_view.set_status(Some(
                        "That extension is no longer listed. Run /extensions refresh.".to_string(),
                    ));
                    return;
                };
                Some((source.stable_key.clone(), *enabled))
            }
            _ => None,
        };
        let expected_preference_revision = self
            .external_control_snapshot
            .as_ref()
            .map(|snapshot| snapshot.preference_revision);
        let task_action = action.clone();
        if self.agent.is_remote_workspace() {
            chat_view.set_status(Some(
                "External source management is unavailable for a Remote workspace".to_string(),
            ));
            return;
        }
        let workspace = self.agent.workspace_id();
        let (sender, receiver) = mpsc::channel();
        rt_handle.spawn(async move {
            let result = async {
                if matches!(&task_action, ExternalControlUiAction::Show) {
                    let surface =
                        openbitfun_core::external_sources::get_external_source_control_snapshot(
                            workspace.as_deref(),
                            false,
                            openbitfun_product_domains::external_sources::ExternalSourceHostCapabilities::read_write(),
                        )
                        .await?;
                    let preferences =
                        openbitfun_core::external_sources::external_source_conflict_choices()
                            .await
                            .map(ExternalSourceConflictPreferences::from)
                            .map_err(
                                openbitfun_core::external_sources::sanitize_external_source_operation_error,
                            )?;
                    return Ok((
                        surface.control,
                        Some(surface.catalog),
                        Some(preferences),
                    ));
                }

                let action = match &task_action {
                    ExternalControlUiAction::Refresh => ExternalSourceControlActionV1::Refresh,
                    ExternalControlUiAction::SetSafeMode(enabled) => {
                        ExternalSourceControlActionV1::SetSafeMode { enabled: *enabled }
                    }
                    ExternalControlUiAction::SetSourceEnabled { .. } => {
                        let (source_key, enabled) = source_selection
                            .clone()
                            .expect("source selection was resolved before spawning");
                        ExternalSourceControlActionV1::SetSourceEnabled {
                            source_key,
                            enabled,
                        }
                    }
                    ExternalControlUiAction::Show => unreachable!(),
                };
                let surface = openbitfun_core::external_sources::apply_external_source_control_action(
                    workspace.as_deref(),
                    ExternalSourceControlRequestV1 {
                        schema_version: EXTERNAL_SOURCE_CONTROL_SCHEMA_V1,
                        operation_id: format!("tui-{}", uuid::Uuid::new_v4()),
                        expected_preference_revision,
                        action,
                    },
                )
                .await?;
                let snapshot =
                    openbitfun_core::external_sources::get_external_source_control_snapshot(
                        workspace.as_deref(),
                        false,
                        openbitfun_product_domains::external_sources::ExternalSourceHostCapabilities::read_write(),
                    )
                    .await?;
                let preferences = openbitfun_core::external_sources::external_source_conflict_choices()
                    .await
                    .map(ExternalSourceConflictPreferences::from)
                    .map_err(
                        openbitfun_core::external_sources::sanitize_external_source_operation_error,
                    )?;
                Ok((
                    surface.control,
                    Some(snapshot.catalog),
                    Some(preferences),
                ))
            }
            .await;
            let _ = sender.send(ExternalControlMutationResult {
                action: task_action,
                result,
            });
        });
        self.external_control_mutation_rx = Some(receiver);
        let status = match action {
            ExternalControlUiAction::Show => "Reading extension status",
            ExternalControlUiAction::Refresh => "Refreshing extensions",
            ExternalControlUiAction::SetSafeMode(true) => "Pausing external access",
            ExternalControlUiAction::SetSafeMode(false) => "Resuming external access",
            ExternalControlUiAction::SetSourceEnabled { enabled: true, .. } => "Enabling extension",
            ExternalControlUiAction::SetSourceEnabled { enabled: false, .. } => {
                "Disabling extension"
            }
        };
        chat_view.set_status(Some(format!(
            "{status}; you can continue typing or cancel other UI work"
        )));
    }

    fn poll_external_control_mutation(&mut self, chat_view: &mut ChatView) -> bool {
        let outcome = match self
            .external_control_mutation_rx
            .as_ref()
            .map(Receiver::try_recv)
        {
            Some(Ok(outcome)) => outcome,
            Some(Err(MpscTryRecvError::Empty)) | None => return false,
            Some(Err(MpscTryRecvError::Disconnected)) => {
                self.external_control_mutation_rx = None;
                chat_view.set_status(Some(
                    "External integration status stopped before returning a result; retry /extensions status."
                        .to_string(),
                ));
                return true;
            }
        };
        self.external_control_mutation_rx = None;
        match outcome.result {
            Ok((control, catalog, preferences)) => {
                if let Some(preferences) = preferences {
                    self.replace_external_conflict_preferences(preferences);
                }
                if let Some(catalog) = catalog {
                    self.update_external_source_view(chat_view, &catalog);
                    self.external_source_snapshot = Some(catalog);
                }
                chat_view.show_info_popup(external_control_status_text(&control));
                self.external_control_snapshot = Some(control);
                let status = match outcome.action {
                    ExternalControlUiAction::Show => "Extension status updated",
                    ExternalControlUiAction::Refresh => "Extensions refreshed",
                    ExternalControlUiAction::SetSafeMode(true) => "External access is paused",
                    ExternalControlUiAction::SetSafeMode(false) => "External access resumed",
                    ExternalControlUiAction::SetSourceEnabled { enabled: true, .. } => {
                        "Extension enabled"
                    }
                    ExternalControlUiAction::SetSourceEnabled { enabled: false, .. } => {
                        "Extension disabled"
                    }
                };
                chat_view.set_status(Some(status.to_string()));
            }
            Err(error) => {
                tracing::warn!(
                    error_code = error.code.as_str(),
                    correlation_id = error.correlation_id.as_deref().unwrap_or("none"),
                    operation_stage = ?error.stage,
                    "External integration control action failed"
                );
                chat_view.set_status(Some(external_operation_error_status("extensions", &error)));
            }
        }
        true
    }

    fn handle_external_tool_review(
        &mut self,
        arguments: &str,
        chat_view: &mut ChatView,
        chat_state: &ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) {
        let action = match parse_external_tool_review_action(
            arguments,
            self.external_source_snapshot.as_ref(),
            self.external_tool_review_snapshot.as_ref(),
        ) {
            Ok(action) => action,
            Err(error) => {
                chat_view.set_status(Some(error));
                return;
            }
        };
        if matches!(action, ExternalToolReviewAction::Show) {
            self.external_tool_review_snapshot = self.external_source_snapshot.clone();
            chat_view.show_info_popup(external_tool_review_text(
                self.external_tool_review_snapshot.as_ref(),
            ));
            return;
        }

        if self.external_tool_mutation_rx.is_some() {
            chat_view.set_status(Some(
                "An external tool update is already running; input and cancellation remain available."
                    .to_string(),
            ));
            return;
        }

        let _ = chat_state;
        let expected_preference_revision = self
            .external_source_snapshot
            .as_ref()
            .map(|snapshot| snapshot.preference_revision)
            .unwrap_or(0);
        let pending_status = match &action {
            ExternalToolReviewAction::Refresh => "Refreshing external tools",
            ExternalToolReviewAction::Decide { approved: true, .. } => "Enabling external tool",
            ExternalToolReviewAction::Decide {
                approved: false, ..
            } => "Disabling external tool",
            ExternalToolReviewAction::Choose { .. } => "Selecting external tool provider",
            ExternalToolReviewAction::Show => unreachable!(),
        };
        let task_action = action.clone();
        if self.agent.is_remote_workspace() {
            chat_view.set_status(Some(
                "External tool management is unavailable for a Remote workspace".to_string(),
            ));
            return;
        }
        let workspace = self.agent.workspace_id();
        let (sender, receiver) = mpsc::channel();
        rt_handle.spawn(async move {
            let result = match &task_action {
                ExternalToolReviewAction::Refresh => {
                    openbitfun_core::external_sources::external_source_snapshot(
                        workspace.as_deref(),
                        true,
                    )
                    .await
                }
                ExternalToolReviewAction::Decide {
                    approval_key,
                    decision_key,
                    approved,
                } => {
                    openbitfun_core::external_sources::set_external_tool_target_decision(
                        workspace.as_deref(),
                        approval_key,
                        decision_key,
                        *approved,
                        expected_preference_revision,
                    )
                    .await
                }
                ExternalToolReviewAction::Choose {
                    conflict_key,
                    candidate_id,
                } => {
                    openbitfun_core::external_sources::set_external_tool_conflict_choice(
                        workspace.as_deref(),
                        conflict_key,
                        candidate_id,
                        expected_preference_revision,
                    )
                    .await
                }
                ExternalToolReviewAction::Show => unreachable!(),
            }
            .map(ExternalSourceCatalogSnapshot::from)
            .map_err(openbitfun_core::external_sources::sanitize_external_source_operation_error);
            let _ = sender.send(ExternalToolMutationResult {
                action: task_action,
                result,
            });
        });
        self.external_tool_mutation_rx = Some(receiver);
        chat_view.set_status(Some(format!(
            "{pending_status}; you can continue typing or cancel other UI work"
        )));
    }

    fn poll_external_tool_mutation(&mut self, chat_view: &mut ChatView) -> bool {
        let outcome = match self
            .external_tool_mutation_rx
            .as_ref()
            .map(Receiver::try_recv)
        {
            Some(Ok(outcome)) => outcome,
            Some(Err(MpscTryRecvError::Empty)) | None => return false,
            Some(Err(MpscTryRecvError::Disconnected)) => {
                self.external_tool_mutation_rx = None;
                chat_view.set_status(Some(
                    "External tool update stopped before returning a result; run /tools refresh and retry."
                        .to_string(),
                ));
                return true;
            }
        };
        self.external_tool_mutation_rx = None;
        match outcome.result {
            Ok(snapshot) => {
                if external_tool_result_is_stale(self.external_source_snapshot.as_ref(), &snapshot)
                {
                    chat_view.set_status(Some(
                        "External tool update completed; a newer catalog result is already displayed."
                            .to_string(),
                    ));
                    return true;
                }
                self.update_external_source_view(chat_view, &snapshot);
                self.external_tool_notice_key = external_tool_pending_notice_key(&snapshot);
                let approvals = snapshot.tool_approval_requests.len();
                let conflicts = snapshot
                    .tool_conflicts
                    .iter()
                    .filter(|conflict| conflict.selected_candidate_id.is_none())
                    .count();
                let result_label = external_tool_mutation_result_label(&outcome.action, &snapshot);
                self.external_source_snapshot = Some(snapshot);
                if approvals + conflicts == 0 {
                    chat_view.set_status(Some(result_label));
                } else {
                    chat_view.set_status(Some(format!(
                        "{result_label}; {approvals} approvals and {conflicts} conflicts remain - run /tools refresh"
                    )));
                }
            }
            Err(error) => {
                tracing::warn!(
                    error_code = error.code.as_str(),
                    correlation_id = error.correlation_id.as_deref().unwrap_or("none"),
                    "External tool review action failed"
                );
                chat_view.set_status(Some(external_operation_error_status("tools", &error)));
            }
        }
        true
    }

    fn take_external_agent_notice(
        &mut self,
        snapshot: &ExternalSourceCatalogSnapshot,
    ) -> Option<String> {
        let attention = external_agent_attention(self.external_source_snapshot.as_ref(), snapshot);
        let next_key = attention.key.clone();
        if next_key == self.external_agent_notice_key {
            return None;
        }
        self.external_agent_notice_key = next_key;
        if attention.bindings
            + attention.confirmations
            + attention.conflicts
            + attention.unavailable
            + attention.diagnostics
            == 0
        {
            None
        } else {
            let mut details = Vec::new();
            if attention.bindings > 0 {
                details.push(format!("{} model bindings", attention.bindings));
            }
            if attention.confirmations > 0 {
                details.push(format!("{} confirmations", attention.confirmations));
            }
            if attention.conflicts > 0 {
                details.push(format!("{} name conflicts", attention.conflicts));
            }
            if attention.unavailable > 0 {
                details.push(format!(
                    "{} enabled agents unavailable",
                    attention.unavailable
                ));
            }
            if attention.diagnostics > 0 {
                details.push(format!("{} issues", attention.diagnostics));
            }
            Some(format!(
                "Agents from external AI applications need attention: {} - run /agent refresh",
                details.join(", ")
            ))
        }
    }

    fn handle_external_agent_review(
        &mut self,
        arguments: &str,
        chat_view: &mut ChatView,
        chat_state: &ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) {
        let action = match parse_external_agent_review_action(
            arguments,
            self.external_source_snapshot.as_ref(),
            self.external_agent_review_snapshot.as_ref(),
        ) {
            Ok(action) => action,
            Err(error) => {
                chat_view.set_status(Some(error));
                return;
            }
        };
        if matches!(action, ExternalAgentReviewAction::Show) {
            self.external_agent_review_snapshot = self.external_source_snapshot.clone();
            chat_view.show_info_popup(external_agent_review_text(
                self.external_agent_review_snapshot.as_ref(),
            ));
            return;
        }
        if self.external_agent_mutation_rx.is_some() {
            chat_view.set_status(Some(
                "An external agent update is already running; input and cancellation remain available."
                    .to_string(),
            ));
            return;
        }

        let _ = chat_state;
        let pending_status = match &action {
            ExternalAgentReviewAction::Refresh => "Refreshing external agents",
            ExternalAgentReviewAction::Decide { approved: true, .. } => "Enabling external agent",
            ExternalAgentReviewAction::Decide {
                approved: false, ..
            } => "Disabling external agent",
            ExternalAgentReviewAction::Choose { .. } => "Selecting agent source",
            ExternalAgentReviewAction::Bind { .. } => "Saving agent model binding",
            ExternalAgentReviewAction::Show => unreachable!(),
        };
        let task_action = action.clone();
        if self.agent.is_remote_workspace() {
            chat_view.set_status(Some(
                "External agent management is unavailable for a Remote workspace".to_string(),
            ));
            return;
        }
        let workspace = self.agent.workspace_id();
        let (sender, receiver) = mpsc::channel();
        rt_handle.spawn(async move {
            let result = match &task_action {
                ExternalAgentReviewAction::Refresh => {
                    openbitfun_core::external_sources::external_source_snapshot(
                        workspace.as_deref(),
                        true,
                    )
                    .await
                }
                ExternalAgentReviewAction::Decide {
                    candidate_id,
                    decision_key,
                    approved,
                    expected_subagent_generation,
                    expected_preference_revision,
                } => {
                    openbitfun_core::external_sources::set_external_subagent_activation(
                        workspace.as_deref(),
                        candidate_id,
                        *approved,
                        *expected_subagent_generation,
                        *expected_preference_revision,
                        decision_key,
                    )
                    .await
                }
                ExternalAgentReviewAction::Choose {
                    conflict_key,
                    candidate_id,
                    approve_external,
                    expected_subagent_generation,
                    expected_preference_revision,
                } => {
                    openbitfun_core::external_sources::choose_external_subagent_conflict(
                        workspace.as_deref(),
                        conflict_key,
                        candidate_id,
                        *approve_external,
                        *expected_subagent_generation,
                        *expected_preference_revision,
                    )
                    .await
                }
                ExternalAgentReviewAction::Bind {
                    binding_key,
                    target,
                    expected_subagent_generation,
                    expected_preference_revision,
                } => {
                    openbitfun_core::external_sources::set_external_subagent_model_binding(
                        workspace.as_deref(),
                        binding_key,
                        target.clone(),
                        *expected_subagent_generation,
                        *expected_preference_revision,
                    )
                    .await
                }
                ExternalAgentReviewAction::Show => unreachable!(),
            }
            .map(ExternalSourceCatalogSnapshot::from)
            .map_err(openbitfun_core::external_sources::sanitize_external_source_operation_error);
            let _ = sender.send(ExternalAgentMutationResult {
                action: task_action,
                result,
            });
        });
        self.external_agent_mutation_rx = Some(receiver);
        chat_view.set_status(Some(format!(
            "{pending_status}; you can continue typing or cancel other UI work"
        )));
    }

    fn poll_external_agent_mutation(&mut self, chat_view: &mut ChatView) -> bool {
        let outcome = match self
            .external_agent_mutation_rx
            .as_ref()
            .map(Receiver::try_recv)
        {
            Some(Ok(outcome)) => outcome,
            Some(Err(MpscTryRecvError::Empty)) | None => return false,
            Some(Err(MpscTryRecvError::Disconnected)) => {
                self.external_agent_mutation_rx = None;
                chat_view.set_status(Some(
                    "External agent update stopped before returning a result; run /agent refresh."
                        .to_string(),
                ));
                return true;
            }
        };
        self.external_agent_mutation_rx = None;
        match outcome.result {
            Ok(snapshot) => {
                if external_agent_result_is_stale(self.external_source_snapshot.as_ref(), &snapshot)
                {
                    chat_view.set_status(Some(
                        "External agent update completed; newer agent results are already displayed."
                            .to_string(),
                    ));
                    return true;
                }
                let snapshot = merge_external_agent_mutation_snapshot(
                    self.external_source_snapshot.as_ref(),
                    snapshot,
                );
                self.update_external_source_view(chat_view, &snapshot);
                self.external_agent_notice_key =
                    external_agent_pending_notice_key(Some(&snapshot), &snapshot);
                let confirmations = snapshot.pending_subagent_approvals.len();
                let bindings = snapshot
                    .subagent_model_binding_groups
                    .iter()
                    .filter(|binding| {
                        matches!(
                            binding.method,
                            ExternalSubagentModelBindingMethod::BindingRequired
                                | ExternalSubagentModelBindingMethod::BindingUnavailable
                        )
                    })
                    .count();
                let conflicts = snapshot
                    .subagent_conflicts
                    .iter()
                    .filter(|conflict| conflict.selected_candidate_id.is_none())
                    .count();
                let result_label = external_agent_mutation_result_label(&outcome.action, &snapshot);
                self.external_source_snapshot = Some(snapshot);
                if bindings + confirmations + conflicts == 0 {
                    chat_view.set_status(Some(result_label));
                } else {
                    chat_view.set_status(Some(format!(
                        "{result_label}; {bindings} model bindings, {confirmations} confirmations, and {conflicts} conflicts remain - run /agent refresh"
                    )));
                }
            }
            Err(error) => {
                tracing::warn!(
                    error_code = error.code.as_str(),
                    correlation_id = error.correlation_id.as_deref().unwrap_or("none"),
                    "External agent review action failed"
                );
                chat_view.set_status(Some(external_operation_error_status("agents", &error)));
            }
        }
        true
    }
}
