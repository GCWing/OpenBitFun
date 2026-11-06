fn shared_session_change_is_blocked(is_shared: bool, session_update_pending: bool) -> bool {
    is_shared && session_update_pending
}

fn session_switch_targets_pending_delete(
    target_session_id: &str,
    pending: Option<(&str, &PendingSessionOperationKind)>,
) -> bool {
    pending.is_some_and(|(pending_session_id, kind)| {
        pending_session_id == target_session_id
            && matches!(kind, PendingSessionOperationKind::Delete { .. })
    })
}

impl ChatMode {
    fn handle_key_event(
        &mut self,
        key: KeyEvent,
        chat_view: &mut ChatView,
        chat_state: &mut ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) -> Result<Option<ChatExitReason>> {
        if key.kind != KeyEventKind::Press && key.kind != KeyEventKind::Repeat {
            return Ok(None);
        }
        if self.pending_local_effect.is_some() {
            return Ok(None);
        }

        if chat_view.prompt_command_shell_review_visible() {
            let action = chat_view.prompt_command_shell_review_handle_key(key);
            match action {
                PromptCommandShellReviewAction::None => {}
                PromptCommandShellReviewAction::Cancel => {
                    self.pending_prompt_command_shell_invocation = None;
                    chat_view.hide_prompt_command_shell_review();
                    chat_view.set_status(Some(
                        "External prompt command cancelled before running local commands"
                            .to_string(),
                    ));
                }
                PromptCommandShellReviewAction::RunOnce
                | PromptCommandShellReviewAction::Remember => {
                    let Some(pending) = self.pending_prompt_command_shell_invocation.take() else {
                        chat_view.hide_prompt_command_shell_review();
                        return Ok(None);
                    };
                    chat_view.hide_prompt_command_shell_review();
                    let decision = PromptCommandShellReviewDecision {
                        plan_fingerprint: pending.review.plan_fingerprint,
                        mode: if matches!(action, PromptCommandShellReviewAction::Remember) {
                            PromptCommandShellReviewMode::Remember
                        } else {
                            PromptCommandShellReviewMode::RunOnce
                        },
                        expected_preference_revision: pending.review.preference_revision,
                    };
                    return self.invoke_external_prompt_command(
                        pending.invocation,
                        Some(decision),
                        chat_view,
                        chat_state,
                        rt_handle,
                    );
                }
            }
            return Ok(None);
        }

        let modal_state =
            self.action_state(chat_state.is_processing, self.any_popup_visible(chat_view));
        if let Some(action) = self.keymap.resolve_modal_safe(key, modal_state) {
            return self.dispatch_action(action, modal_state, chat_view, chat_state, rt_handle);
        }

        if let Some(ref mut prompt) = chat_state.permission_prompt {
            match prompt.handle_key_event(key) {
                PermissionAction::Reply(reply) => {
                    let request_id = prompt.request.request_id.clone();
                    let agent = Arc::clone(&self.agent);
                    let result = tokio::task::block_in_place(|| {
                        rt_handle.block_on(agent.respond_permission(&request_id, reply))
                    });
                    match result {
                        Ok(()) => {
                            chat_state.resolve_permission_request(&request_id);
                            chat_view.set_status(Some("Permission response sent".to_string()));
                        }
                        Err(error) => {
                            tracing::error!("Failed to respond to permission request: {error}");
                            chat_view.set_status(Some(format!("Error: {error}")));
                        }
                    }
                }
                PermissionAction::None => {}
            }
            return Ok(None);
        }

        // ── Question prompt intercepts all keys when active ──
        if let Some(ref mut prompt) = chat_state.question_prompt {
            if !prompt.interaction_acknowledged && key.code != KeyCode::Esc {
                match tokio::task::block_in_place(|| {
                    rt_handle.block_on(self.agent.start_question_interaction(&prompt.tool_id))
                }) {
                    Ok(()) => prompt.interaction_acknowledged = true,
                    Err(error) => chat_view.set_status(Some(format!(
                        "Question timeout could not be stopped: {error}"
                    ))),
                }
            }
            let action = prompt.handle_key_event(key);
            match action {
                QuestionAction::Submit(answers) => {
                    let tool_id = prompt.tool_id.clone();
                    let agent = self.agent.clone();
                    tracing::info!("User submitted answers for tool: {}", tool_id);
                    match tokio::task::block_in_place(|| {
                        rt_handle.block_on(agent.submit_user_answers(&tool_id, answers))
                    }) {
                        Ok(()) => {
                            chat_state.resolve_question_prompt(&tool_id);
                            chat_view.set_status(Some("Answers submitted".to_string()));
                        }
                        Err(error) => {
                            tracing::error!("Failed to submit answers: {error}");
                            chat_view.set_status(Some(format!("Error: {error}")));
                        }
                    }
                }
                QuestionAction::Reject => {
                    let tool_id = prompt.tool_id.clone();
                    if let Err(error) = tokio::task::block_in_place(|| {
                        rt_handle.block_on(self.agent.cancel_user_question(&tool_id))
                    }) {
                        chat_view.set_status(Some(format!("Question dismissal failed: {error}")));
                        return Ok(None);
                    }
                    chat_state.resolve_question_prompt(&tool_id);
                    tracing::info!("User dismissed question prompt: {}", tool_id);
                    chat_view.set_status(Some("Question dismissed".to_string()));
                }
                QuestionAction::None => {
                    // Question prompt consumed the key, no further action
                }
            }
            return Ok(None);
        }

        // Host recovery keys win over popup-specific input handling.
        if self.any_popup_visible(chat_view) {
            let state = self.action_state(chat_state.is_processing, true);
            if let Some(action) = self.keymap.resolve_reserved(key, state) {
                return self.dispatch_action(action, state, chat_view, chat_state, rt_handle);
            }
        }

        if chat_view.export_dialog_visible() {
            match chat_view.export_dialog_handle_key(key) {
                crate::ui::export_dialog::ExportDialogAction::Confirm(request) => {
                    let markdown = transcript::render_session_markdown(
                        self.displayed_chat_state(chat_state),
                        transcript::MarkdownTranscriptOptions {
                            include_reasoning: request.include_reasoning,
                            include_tool_details: request.include_tool_details,
                        },
                    );
                    self.prepare_transcript_export(request, false, chat_view, markdown);
                }
                crate::ui::export_dialog::ExportDialogAction::ConfirmOverwrite(request) => {
                    let markdown = transcript::render_session_markdown(
                        self.displayed_chat_state(chat_state),
                        transcript::MarkdownTranscriptOptions {
                            include_reasoning: request.include_reasoning,
                            include_tool_details: request.include_tool_details,
                        },
                    );
                    self.prepare_transcript_export(request, true, chat_view, markdown);
                }
                crate::ui::export_dialog::ExportDialogAction::Cancel => {
                    self.close_all_popups(chat_view);
                    chat_view.set_status(Some("Transcript export cancelled".to_string()));
                }
                crate::ui::export_dialog::ExportDialogAction::None => {}
            }
            return Ok(None);
        }

        // ── Normal key handling ──

        // Workspace diff viewer intercepts all keys when visible
        if chat_view.workspace_diff_visible() {
            if matches!(
                chat_view.workspace_diff_handle_key(key),
                crate::ui::workspace_diff::WorkspaceDiffAction::Close
            ) {
                self.navigate_back(chat_view);
            }
            return Ok(None);
        }

        // Info popup intercepts all keys when visible
        if chat_view.info_popup_visible() {
            match key.code {
                KeyCode::Up => chat_view.info_popup_scroll_up(1),
                KeyCode::Down => chat_view.info_popup_scroll_down(1),
                KeyCode::PageUp => chat_view.info_popup_scroll_up(10),
                KeyCode::PageDown => chat_view.info_popup_scroll_down(10),
                KeyCode::Home => chat_view.info_popup_scroll_to_start(),
                KeyCode::End => chat_view.info_popup_scroll_to_end(),
                KeyCode::Esc => chat_view.dismiss_info_popup(),
                _ => {}
            }
            return Ok(None);
        }

        // Command palette intercepts all keys when visible
        if chat_view.command_palette_visible() {
            let action = chat_view.command_palette_handle_key(key);
            match action {
                PaletteAction::Execute(id) => {
                    return self.handle_palette_action(&id, chat_view, chat_state, rt_handle);
                }
                PaletteAction::Dismiss => self.navigate_back(chat_view),
                PaletteAction::None => {}
            }
            return Ok(None);
        }

        // Handle popup events first (when visible)
        if chat_view.model_selector_visible() {
            match key.code {
                KeyCode::Up => chat_view.model_selector_up(),
                KeyCode::Down => chat_view.model_selector_down(),
                KeyCode::Enter => {
                    if let Some(selected) = chat_view.model_selector_confirm() {
                        chat_view.hide_model_selector();
                        self.apply_model_selection(&selected, chat_view, chat_state, rt_handle);
                    }
                }
                KeyCode::Char('e') if chat_view.model_selector_allows_edit() => {
                    if let Some(selected) = chat_view.model_selector_confirm() {
                        chat_view.hide_model_selector();
                        self.edit_model(&selected, chat_view, rt_handle);
                    }
                }
                // Note: Esc is handled globally for navigation back
                _ => {}
            }
            return Ok(None);
        }

        if chat_view.theme_selector_visible() {
            match key.code {
                KeyCode::Up => {
                    chat_view.theme_selector_up();
                    if let Some(selected) = chat_view.theme_selector_selected() {
                        self.preview_theme_selection(&selected, chat_view);
                    }
                }
                KeyCode::Down => {
                    chat_view.theme_selector_down();
                    if let Some(selected) = chat_view.theme_selector_selected() {
                        self.preview_theme_selection(&selected, chat_view);
                    }
                }
                KeyCode::Enter => {
                    if let Some(selected) = chat_view.theme_selector_confirm() {
                        chat_view.hide_theme_selector();
                        self.apply_theme_selection(&selected, chat_view);
                        chat_view.commit_theme_preview();
                    }
                }
                // Note: Esc is handled globally for navigation back
                _ => {}
            }
            return Ok(None);
        }

        if chat_view.agent_selector_visible() {
            match key.code {
                KeyCode::Up => chat_view.agent_selector_up(),
                KeyCode::Down => chat_view.agent_selector_down(),
                KeyCode::Enter => {
                    if let Some(action) = chat_view.agent_selector_confirm() {
                        self.handle_agent_selector_action(action, chat_view, chat_state, rt_handle);
                    }
                }
                // Note: Esc is handled globally for navigation back
                _ => {}
            }
            return Ok(None);
        }

        if chat_view.session_selector_visible() {
            let action = chat_view.session_selector_handle_key(key);
            match action {
                SessionAction::Switch(item) => {
                    return Ok(Some(ChatExitReason::SwitchSession(item.session_id)));
                }
                SessionAction::Delete(item) => {
                    self.handle_session_delete(&item, chat_view, chat_state, rt_handle);
                }
                SessionAction::Close | SessionAction::None => {}
            }
            return Ok(None);
        }

        if chat_view.session_lineage_selector_visible() {
            match chat_view.session_lineage_selector_handle_key(key) {
                SessionLineageAction::Select(session_id) => {
                    self.close_all_popups(chat_view);
                    self.inspect_lineage_session(&session_id, chat_view, rt_handle);
                }
                SessionLineageAction::Close => self.navigate_back(chat_view),
                SessionLineageAction::Move(_) | SessionLineageAction::None => {}
            }
            return Ok(None);
        }

        if chat_view.fork_selector_visible() {
            match chat_view.fork_selector_handle_key(key) {
                ForkAction::Select(target) => {
                    return Ok(Some(ChatExitReason::ForkSession(target)));
                }
                ForkAction::Close | ForkAction::None => {}
            }
            return Ok(None);
        }

        if chat_view.timeline_selector_visible() {
            match chat_view.timeline_selector_handle_key(key) {
                crate::ui::timeline_selector::TimelineAction::Move(message_id) => {
                    chat_view.scroll_to_message(self.displayed_chat_state(chat_state), &message_id);
                }
                crate::ui::timeline_selector::TimelineAction::Select(message_id) => {
                    chat_view
                        .commit_message_jump(self.displayed_chat_state(chat_state), &message_id);
                    self.navigate_back(chat_view);
                }
                crate::ui::timeline_selector::TimelineAction::Close => {
                    self.navigate_back(chat_view);
                }
                crate::ui::timeline_selector::TimelineAction::None => {}
            }
            return Ok(None);
        }

        if chat_view.message_queue_visible() {
            match chat_view.message_queue_handle_key(key) {
                crate::ui::message_queue::QueueAction::Close => self.navigate_back(chat_view),
                crate::ui::message_queue::QueueAction::Refresh => {
                    self.refresh_message_queue(chat_view, rt_handle, None)
                }
                crate::ui::message_queue::QueueAction::Request(request) => {
                    self.refresh_message_queue(chat_view, rt_handle, Some(request))
                }
                crate::ui::message_queue::QueueAction::None => {}
            }
            return Ok(None);
        }

        if chat_view.prompt_stash_selector_visible() {
            match chat_view.prompt_stash_selector_handle_key(key) {
                PromptStashAction::Select(id) => {
                    self.restore_prompt_stash(&id, chat_view);
                }
                PromptStashAction::Close => self.navigate_back(chat_view),
                PromptStashAction::None => {}
            }
            return Ok(None);
        }

        if chat_view.skill_selector_visible() {
            match key.code {
                KeyCode::Up => chat_view.skill_selector_up(),
                KeyCode::Down => chat_view.skill_selector_down(),
                KeyCode::Enter | KeyCode::Char(' ') => {
                    if let Some(action) = chat_view.skill_selector_confirm() {
                        self.handle_skill_selector_action(action, chat_view, chat_state, rt_handle);
                    }
                }
                // Note: Esc is handled globally for navigation back
                _ => {}
            }
            return Ok(None);
        }

        if chat_view.subagent_selector_visible() {
            match key.code {
                KeyCode::Up => chat_view.subagent_selector_up(),
                KeyCode::Down => chat_view.subagent_selector_down(),
                KeyCode::Enter | KeyCode::Char(' ') => {
                    if let Some(action) = chat_view.subagent_selector_confirm() {
                        self.handle_subagent_selector_action(
                            action, chat_view, chat_state, rt_handle,
                        );
                    }
                }
                // Note: Esc is handled globally for navigation back
                _ => {}
            }
            return Ok(None);
        }

        if chat_view.mcp_selector_visible() {
            match key.code {
                KeyCode::Up => chat_view.mcp_selector_up(),
                KeyCode::Down => chat_view.mcp_selector_down(),
                KeyCode::Enter | KeyCode::Char(' ') => {
                    if let Some(selected) = chat_view.mcp_selector_confirm() {
                        if selected.requires_external_confirmation()
                            && !chat_view.mcp_selector_is_confirm_external(&selected.id)
                        {
                            chat_view.mcp_selector_start_confirm_external(selected.id.clone());
                        } else {
                            chat_view.mcp_selector_cancel_confirm_external();
                            self.activate_mcp_item(selected, chat_view, chat_state);
                        }
                    }
                }
                KeyCode::Char('a') => {
                    // Open add dialog (hide selector first)
                    chat_view.hide_mcp_selector();
                    chat_view.show_mcp_add_dialog();
                }
                KeyCode::Char('d') => {
                    if let Some(selected) = chat_view.mcp_selector_confirm() {
                        if selected.is_external() {
                            chat_state.add_system_message(
                                "External MCP settings are read-only in OpenBitFun. Disable the server here or edit it in the source application."
                                    .to_string(),
                            );
                            return Ok(None);
                        }
                        // First press: enter confirm-delete mode
                        // Second press: actually delete (handled by confirm_delete state)
                        if chat_view.mcp_selector_is_confirm_delete(&selected.id) {
                            self.delete_mcp_server(&selected.id, chat_view);
                        } else {
                            chat_view.mcp_selector_start_confirm_delete(selected.id.clone());
                        }
                    }
                }
                KeyCode::Char('e') => {
                    if chat_view
                        .mcp_selector_confirm()
                        .is_some_and(|selected| selected.is_external())
                    {
                        chat_state.add_system_message(
                            "External MCP settings are read-only in OpenBitFun. Edit them in the source application."
                                .to_string(),
                        );
                    } else {
                        chat_view.hide_mcp_selector();
                        self.open_mcp_config(chat_state, rt_handle);
                    }
                }
                // Note: Esc is handled globally for navigation back
                _ => {
                    // Any other key cancels the confirm-delete state
                    chat_view.mcp_selector_cancel_confirm_delete();
                    chat_view.mcp_selector_cancel_confirm_external();
                }
            }
            return Ok(None);
        }

        if chat_view.mcp_add_dialog_visible() {
            let action = chat_view.mcp_add_dialog_handle_key(key);
            match action {
                McpAddAction::Confirm { name, config_json } => {
                    self.add_mcp_server(&name, &config_json, chat_view);
                }
                McpAddAction::Cancel => {
                    // Re-open the MCP selector
                    self.show_mcp_selector(chat_view, chat_state, rt_handle);
                }
                McpAddAction::None => {}
            }
            return Ok(None);
        }

        if chat_view.provider_selector_visible() {
            if let Some(selection) = chat_view.provider_selector_handle_key(key) {
                self.handle_provider_selection(selection, chat_view);
            }
            return Ok(None);
        }

        if chat_view.model_config_form_visible() {
            let action = chat_view.model_config_form_handle_key(key);
            match action {
                ModelFormAction::Save(result) => {
                    if result.editing_model_id.is_some() {
                        self.update_existing_model(result, chat_view, chat_state, rt_handle);
                    } else {
                        self.save_new_model(result, chat_view, chat_state, rt_handle);
                    }
                }
                ModelFormAction::Cancel => {
                    chat_view.set_status(Some("Model form cancelled".to_string()));
                }
                ModelFormAction::None => {}
            }
            return Ok(None);
        }

        if chat_view.login_form_visible() {
            let action = chat_view.login_form_handle_key(key);
            return self.handle_login_form_action(action, chat_view, chat_state, rt_handle);
        }

        if chat_view.workspace_reference_popup_visible() {
            match (key.code, key.modifiers) {
                (KeyCode::Up, _) | (KeyCode::Char('p'), KeyModifiers::CONTROL) => {
                    chat_view.workspace_reference_up();
                    return Ok(None);
                }
                (KeyCode::Down, _) | (KeyCode::Char('n'), KeyModifiers::CONTROL) => {
                    chat_view.workspace_reference_down();
                    return Ok(None);
                }
                (KeyCode::Enter, _) => {
                    chat_view.apply_workspace_reference_selection(false);
                    return Ok(None);
                }
                (KeyCode::Tab, _) => {
                    chat_view.apply_workspace_reference_selection(true);
                    return Ok(None);
                }
                (KeyCode::Esc, _) => {
                    chat_view.hide_workspace_reference_popup();
                    return Ok(None);
                }
                _ => {}
            }
        }

        if chat_view.is_shell_mode() {
            match key.code {
                KeyCode::Esc => {
                    chat_view.exit_shell_mode();
                    self.selected_native_command_once = None;
                    return Ok(None);
                }
                KeyCode::Backspace if chat_view.input_text().is_empty() => {
                    chat_view.exit_shell_mode();
                    self.selected_native_command_once = None;
                    return Ok(None);
                }
                _ => {}
            }
        }

        if key.code == KeyCode::Esc && self.cancel_pending_lineage_load(chat_view) {
            return Ok(None);
        }

        if self.lineage_inspection.is_some() {
            match key.code {
                KeyCode::Up => self.navigate_lineage_parent(chat_view, rt_handle),
                KeyCode::Left => self.navigate_lineage_sibling(-1, chat_view, rt_handle),
                KeyCode::Right => self.navigate_lineage_sibling(1, chat_view, rt_handle),
                KeyCode::Esc => self.leave_lineage_inspection(chat_view),
                _ => {
                    if let Some(action) = self.keymap.resolve(
                        key,
                        self.action_state(
                            self.displayed_chat_state(chat_state).is_processing,
                            false,
                        ),
                    ) {
                        return self.dispatch_action(
                            action,
                            self.action_state(
                                self.displayed_chat_state(chat_state).is_processing,
                                false,
                            ),
                            chat_view,
                            chat_state,
                            rt_handle,
                        );
                    }
                }
            }
            return Ok(None);
        }

        if let Some(action) = self
            .keymap
            .resolve(key, self.action_state(chat_state.is_processing, false))
        {
            return self.dispatch_action(
                action,
                self.action_state(chat_state.is_processing, false),
                chat_view,
                chat_state,
                rt_handle,
            );
        }

        match (key.code, key.modifiers) {
            (KeyCode::Backspace, _) => {
                chat_view.handle_backspace();
                self.sync_selected_native_command(chat_view);
            }
            (KeyCode::Delete, _) => {
                chat_view.handle_delete();
                self.sync_selected_native_command(chat_view);
            }

            (KeyCode::Left, _) => {
                chat_view.move_cursor_left();
            }
            (KeyCode::Right, _) => {
                chat_view.move_cursor_right();
            }

            (KeyCode::Home, _) => {
                chat_view.set_cursor_home();
            }

            (KeyCode::End, _) => {
                chat_view.set_cursor_end();
            }

            (KeyCode::Esc, _) => {
                if chat_view.browse_mode {
                    chat_view.scroll_to_bottom();
                    chat_view.set_status(Some("Exited browse mode".to_string()));
                }
            }

            (KeyCode::Char('!'), KeyModifiers::NONE | KeyModifiers::SHIFT)
                if !chat_state.is_processing && chat_view.try_enter_shell_mode() =>
            {
                self.selected_native_command_once = None;
            }

            (KeyCode::Char(c), KeyModifiers::NONE | KeyModifiers::SHIFT)
                if !c.is_control() && c != '\u{0}' =>
            {
                chat_view.handle_char(c);
                self.sync_selected_native_command(chat_view);
            }

            _ => {}
        }

        Ok(None)
    }

    /// Apply an exit reason from handle_key_event (shared by normal and batch paths).
    fn apply_exit_reason(reason: ChatExitReason, context: ChatEventContext<'_>) {
        let ChatEventContext {
            this,
            chat_view,
            chat_state,
            session_id,
            rt_handle,
            should_quit,
            exit_reason,
        } = context;
        if let ChatExitReason::SwitchSession(target_session_id) = &reason {
            let pending = this
                .pending_session_operation
                .as_ref()
                .map(|operation| (operation.session_id.as_str(), &operation.kind));
            if session_switch_targets_pending_delete(target_session_id, pending) {
                chat_view.set_status(Some(
                    "Wait for this Session's pending deletion to finish before opening it."
                        .to_string(),
                ));
                return;
            }
        }
        if matches!(
            &reason,
            ChatExitReason::SwitchSession(_)
                | ChatExitReason::ForkSession(_)
                | ChatExitReason::NewSession
        ) && shared_session_change_is_blocked(
            this.agent.is_shared(),
            this.pending_session_operation.is_some(),
        ) {
            chat_view.set_status(Some(
                "Wait for the pending Session operation to finish before changing sessions."
                    .to_string(),
            ));
            return;
        }
        match reason {
            ChatExitReason::SwitchSession(new_session_id) => {
                if let Some(pending) = this.pending_session_operation.as_mut() {
                    pending.exit_warning_shown = false;
                }
                match this.switch_to_session(
                    &new_session_id,
                    session_id,
                    chat_state,
                    chat_view,
                    rt_handle,
                ) {
                    Ok(()) => tracing::info!("Switched to session: {}", new_session_id),
                    Err(e) => {
                        chat_state.add_system_message(format!("Failed to switch session: {}", e));
                        tracing::error!("Failed to switch session: {}", e);
                    }
                }
            }
            ChatExitReason::NewSession => {
                if let Some(pending) = this.pending_session_operation.as_mut() {
                    pending.exit_warning_shown = false;
                }
                match this.create_new_session(session_id, chat_state, chat_view, rt_handle) {
                    Ok(()) => tracing::info!("Created new session: {}", session_id),
                    Err(e) => {
                        chat_state
                            .add_system_message(format!("Failed to create new session: {}", e));
                        tracing::error!("Failed to create new session: {}", e);
                    }
                }
            }
            ChatExitReason::ForkSession(target) => {
                match this.fork_session(target, session_id, chat_state, chat_view, rt_handle) {
                    Ok(()) => tracing::info!("Forked current session: {}", session_id),
                    Err(error) => {
                        chat_view.set_status(Some(format!("Failed to fork session: {error}")));
                        tracing::error!("Failed to fork session: {error}");
                    }
                }
            }
            ChatExitReason::Quit => {
                if let Some(pending) = this.pending_session_operation.as_mut() {
                    if !pending.exit_warning_shown {
                        pending.exit_warning_shown = true;
                        chat_view.set_status(Some(
                            "Exit requested. Waiting for the pending Session operation to finish; exit again to leave now. Its outcome may be unknown until the Session list is inspected again."
                                .to_string(),
                        ));
                        return;
                    }
                }
                *should_quit = true;
                *exit_reason = ChatExitReason::Quit;
            }
        }
    }

    /// Handle non-key events (Mouse, Paste, Resize, etc.).
    fn handle_non_key_event(
        event: Event,
        context: ChatEventContext<'_>,
    ) -> Result<NonKeyEventOutcome> {
        let mut outcome = NonKeyEventOutcome::default();
        match event {
            Event::Mouse(mouse) => {
                if context.chat_view.command_palette_captures_mouse(&mouse) {
                    let action = context.chat_view.command_palette_handle_mouse(&mouse);
                    match action {
                        PaletteAction::Execute(id) => {
                            if let Some(reason) = context.this.handle_palette_action(
                                &id,
                                context.chat_view,
                                context.chat_state,
                                context.rt_handle,
                            )? {
                                Self::apply_exit_reason(
                                    reason,
                                    ChatEventContext {
                                        this: &mut *context.this,
                                        chat_view: &mut *context.chat_view,
                                        chat_state: &mut *context.chat_state,
                                        session_id: &mut *context.session_id,
                                        rt_handle: context.rt_handle,
                                        should_quit: &mut *context.should_quit,
                                        exit_reason: &mut *context.exit_reason,
                                    },
                                );
                            }
                        }
                        PaletteAction::Dismiss => context.this.navigate_back(context.chat_view),
                        PaletteAction::None => {}
                    }
                } else if context.chat_view.provider_selector_captures_mouse(&mouse) {
                    if let Some(selection) =
                        context.chat_view.provider_selector_handle_mouse(&mouse)
                    {
                        context
                            .this
                            .handle_provider_selection(selection, context.chat_view);
                    }
                } else if context.chat_view.handle_mouse_event(&mouse) {
                    if let Some(action) = context.chat_view.take_pending_agent_action() {
                        context.this.handle_agent_selector_action(
                            action,
                            context.chat_view,
                            context.chat_state,
                            context.rt_handle,
                        );
                    }
                    if let Some(action) = context.chat_view.take_pending_skill_action() {
                        context.this.handle_skill_selector_action(
                            action,
                            context.chat_view,
                            context.chat_state,
                            context.rt_handle,
                        );
                    }
                    if let Some(action) = context.chat_view.take_pending_subagent_action() {
                        context.this.handle_subagent_selector_action(
                            action,
                            context.chat_view,
                            context.chat_state,
                            context.rt_handle,
                        );
                    }
                } else {
                    match mouse.kind {
                        MouseEventKind::ScrollUp => {
                            let total = context.chat_view.count_message_lines(
                                context.this.displayed_chat_state(context.chat_state),
                            );
                            context.chat_view.scroll_up(3, total);
                        }
                        MouseEventKind::ScrollDown => {
                            context.chat_view.scroll_down(3);
                        }
                        MouseEventKind::Down(MouseButton::Left) => {
                            let _ = context
                                .chat_view
                                .begin_mouse_selection(mouse.column, mouse.row);
                        }
                        MouseEventKind::Drag(MouseButton::Left) => {
                            let _ = context
                                .chat_view
                                .update_mouse_selection(mouse.column, mouse.row);
                        }
                        MouseEventKind::Up(MouseButton::Left) => {
                            match context
                                .chat_view
                                .complete_mouse_selection_or_click(mouse.column, mouse.row)
                            {
                                MouseGestureOutcome::CopyText(text) => {
                                    match Clipboard::new().and_then(|mut cb| cb.set_text(text)) {
                                        Ok(()) => context
                                            .chat_view
                                            .set_status(Some("Copied to clipboard".to_string())),
                                        Err(_) => context.chat_view.set_status(Some(
                                            "Failed to copy selection".to_string(),
                                        )),
                                    }
                                }
                                MouseGestureOutcome::Click(col, row) => {
                                    context.chat_view.handle_mouse_click(col, row);
                                }
                                MouseGestureOutcome::None => {}
                            }
                        }
                        MouseEventKind::Moved
                            if !context
                                .chat_view
                                .update_mouse_selection(mouse.column, mouse.row) =>
                        {
                            context.chat_view.handle_mouse_move(mouse.column, mouse.row);
                        }
                        _ => {}
                    }
                }
                if let Some(selection) = context.chat_view.take_pending_command() {
                    if let Some(reason) = context.this.handle_action_id(
                        &selection.action_id,
                        Some(&selection.command_name),
                        context.chat_view,
                        context.chat_state,
                        context.rt_handle,
                    )? {
                        Self::apply_exit_reason(
                            reason,
                            ChatEventContext {
                                this: &mut *context.this,
                                chat_view: &mut *context.chat_view,
                                chat_state: &mut *context.chat_state,
                                session_id: &mut *context.session_id,
                                rt_handle: context.rt_handle,
                                should_quit: &mut *context.should_quit,
                                exit_reason: &mut *context.exit_reason,
                            },
                        );
                    }
                }
                if let Some(theme) = context.chat_view.take_pending_theme_preview() {
                    context
                        .this
                        .preview_theme_selection(&theme, context.chat_view);
                }
                if let Some(item) = context.chat_view.take_pending_mcp_toggle() {
                    context
                        .this
                        .activate_mcp_item(item, context.chat_view, context.chat_state);
                }
                outcome.request_redraw = true;
            }
            Event::Paste(text) => {
                if context.this.lineage_inspection.is_some() {
                    // The root composer is deliberately hidden and immutable while a
                    // descendant transcript is being inspected.
                } else if context.chat_view.export_dialog_visible() {
                    context.chat_view.export_dialog_handle_paste(&text);
                } else if context.chat_view.mcp_add_dialog_visible() {
                    context.chat_view.mcp_add_dialog_handle_paste(&text);
                } else if context.chat_view.login_form_visible() {
                    context.chat_view.login_form_insert_paste(&text);
                } else if context.chat_state.permission_prompt.is_none()
                    && context.chat_state.question_prompt.is_none()
                    && !context.this.any_popup_visible(context.chat_view)
                {
                    context.this.paste_terminal_text(&text, context.chat_view);
                }
                outcome.request_redraw = true;
            }
            Event::Resize(_, _) => {
                outcome.resize_observed = true;
            }
            _ => {}
        }
        Ok(outcome)
    }
}
