impl ChatMode {
    fn fork_session(
        &mut self,
        target: ForkTarget,
        session_id: &mut String,
        chat_state: &mut ChatState,
        chat_view: &mut ChatView,
        rt_handle: &tokio::runtime::Handle,
    ) -> Result<()> {
        let source_session_id = chat_state.core_session_id.clone();
        let (before_turn_id, prefill, prefill_message_id) = match target {
            ForkTarget::FullSession => (None, None, None),
            ForkTarget::BeforeTurn {
                turn_id,
                message_id,
                prompt,
            } => (Some(turn_id), Some(prompt), Some(message_id)),
        };
        let prefill_references =
            prefill_message_id
                .map(|message_id| {
                    let agent = self.agent.clone();
                    tokio::task::block_in_place(|| {
                        rt_handle.block_on(agent.workspace_references_for_message(
                            source_session_id.clone(),
                            message_id,
                        ))
                    })
                })
                .transpose()?
                .unwrap_or_default();
        chat_view.set_status(Some("Forking session...".to_string()));
        self.close_all_popups(chat_view);
        let agent = self.agent.clone();
        let (summary, workspace_binding, transcript) = tokio::task::block_in_place(|| {
            rt_handle.block_on(agent.fork_current_session(before_turn_id.as_deref()))
        })?;
        let new_session_id = summary.session_id.clone();
        let restored_agent_type = summary.agent_type.clone();
        let mut new_state = ChatState::from_session_transcript(
            new_session_id.clone(),
            summary.session_name.clone(),
            restored_agent_type.clone(),
            Some(workspace_binding.workspace_path.clone()),
            &transcript,
        );
        new_state.current_model_id = summary.model_id;
        new_state.current_reasoning_preset = summary.reasoning_preset;
        new_state.apply_workspace_binding(workspace_binding);

        self.reset_lineage_navigation(chat_view);
        clear_selected_native_command_prefill(&mut self.selected_native_command_once, chat_view);
        chat_view.activate_session_composer(&source_session_id, &new_session_id);
        *session_id = new_session_id.clone();
        *chat_state = new_state;
        self.agent_type = restored_agent_type;
        self.workspace = chat_state.workspace.clone();
        self.refresh_workspace_git_status(chat_state, rt_handle);
        self.auto_approve_ask_override = None;
        chat_state.auto_approve_ask = self.auto_approve_ask_default;
        self.agent
            .set_approval_policy(crate::runtime::approval::CliApprovalPolicy::Ask);
        self.load_current_model_name(chat_state, rt_handle);

        chat_view.clear_screen();
        chat_view.scroll_to_bottom();
        if let Some(prompt) = prefill {
            chat_view.set_draft(crate::ui::composer::ComposerDraft {
                text: prompt,
                workspace_references: prefill_references,
                ..crate::ui::composer::ComposerDraft::default()
            });
            chat_view.set_status(Some(
                "Forked before the selected prompt; review the copied input before sending."
                    .to_string(),
            ));
        } else {
            chat_view.set_status(Some(format!("Forked session: {}", summary.session_name)));
        }
        Ok(())
    }

    /// Switch to a different session: restore it from core, reload messages, update state
    fn switch_to_session(
        &mut self,
        new_session_id: &str,
        session_id: &mut String,
        chat_state: &mut ChatState,
        chat_view: &mut ChatView,
        rt_handle: &tokio::runtime::Handle,
    ) -> Result<()> {
        let previous_session_id = chat_state.core_session_id.clone();
        let agent = self.agent.clone();
        let sid = new_session_id.to_string();

        let (new_state, restored_agent_type, migration_notices) =
            tokio::task::block_in_place(|| {
                rt_handle.block_on(async {
                    let (session_summary, workspace_binding, migration_notices, transcript) =
                        agent.restore_session_in_current_workspace(&sid).await?;
                    let restored_agent_type = session_summary.agent_type.clone();
                    let effective_workspace = Some(workspace_binding.workspace_path.clone());

                    let mut state = ChatState::from_session_transcript(
                        sid.clone(),
                        session_summary.session_name,
                        restored_agent_type.clone(),
                        effective_workspace,
                        &transcript,
                    );
                    state.current_model_id = session_summary.model_id;
                    state.current_reasoning_preset = session_summary.reasoning_preset;
                    state.apply_workspace_binding(workspace_binding);

                    Ok::<_, anyhow::Error>((state, restored_agent_type, migration_notices))
                })
            })?;

        // Update session state
        self.reset_lineage_navigation(chat_view);
        clear_selected_native_command_prefill(&mut self.selected_native_command_once, chat_view);
        chat_view.activate_session_composer(&previous_session_id, new_session_id);
        *session_id = new_session_id.to_string();
        *chat_state = new_state;
        self.agent_type = restored_agent_type;
        self.workspace = chat_state.workspace.clone();
        self.refresh_workspace_git_status(chat_state, rt_handle);
        self.auto_approve_ask_override = None;
        chat_state.auto_approve_ask = self.auto_approve_ask_default;
        self.agent
            .set_approval_policy(crate::runtime::approval::CliApprovalPolicy::Ask);

        // Reload model name
        self.load_current_model_name(chat_state, rt_handle);

        for notice in migration_notices {
            chat_state.add_system_message(notice.user_message());
        }

        // Reset view state
        chat_view.scroll_to_bottom();
        chat_view.set_status(Some(format!("Switched to session: {}", new_session_id)));

        Ok(())
    }

    /// Create a new session: reset state and start fresh
    fn create_new_session(
        &mut self,
        session_id: &mut String,
        chat_state: &mut ChatState,
        chat_view: &mut ChatView,
        rt_handle: &tokio::runtime::Handle,
    ) -> Result<()> {
        let previous_session_id = chat_state.core_session_id.clone();
        let agent = self.agent.clone();
        let agent_type = self.agent_type.clone();

        let (new_session_id, workspace_binding) = tokio::task::block_in_place(|| {
            rt_handle.block_on(async {
                let session_id = agent.create_new_session(&agent_type).await?;
                let binding = agent.session_workspace_binding(&session_id).await?;
                Ok::<_, anyhow::Error>((session_id, binding))
            })
        })?;

        let mut new_state = ChatState::new(
            new_session_id.clone(),
            "New Session".to_string(),
            agent_type,
            Some(workspace_binding.workspace_path.clone()),
        );
        new_state.apply_workspace_binding(workspace_binding);

        self.reset_lineage_navigation(chat_view);
        clear_selected_native_command_prefill(&mut self.selected_native_command_once, chat_view);
        chat_view.activate_session_composer(&previous_session_id, &new_session_id);
        *session_id = new_session_id;
        *chat_state = new_state;
        self.workspace = chat_state.workspace.clone();
        self.refresh_workspace_git_status(chat_state, rt_handle);
        self.auto_approve_ask_override = None;
        chat_state.auto_approve_ask = self.auto_approve_ask_default;
        self.agent
            .set_approval_policy(crate::runtime::approval::CliApprovalPolicy::Ask);

        // Reload model name
        self.load_current_model_name(chat_state, rt_handle);

        // Reset view state
        chat_view.clear_screen();
        chat_view.scroll_to_bottom();
        chat_view.set_status(Some("New session created".to_string()));

        Ok(())
    }

    /// Show skill list/configuration menu.
    /// Send a message to the agent programmatically (used by slash commands like /init)
    fn send_message_to_agent(
        &mut self,
        message: String,
        chat_view: &mut ChatView,
        chat_state: &mut ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) {
        self.send_draft_to_agent(
            crate::ui::composer::ComposerDraft {
                text: message,
                workspace_references: Vec::new(),
                ..crate::ui::composer::ComposerDraft::default()
            },
            chat_view,
            chat_state,
            rt_handle,
        );
    }

    #[allow(clippy::too_many_arguments)]
    fn send_external_subagent_command_to_agent(
        &mut self,
        prompt: String,
        original_command: String,
        ecosystem_id: String,
        logical_id: String,
        chat_view: &mut ChatView,
        chat_state: &mut ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) {
        let submitted_draft = crate::ui::composer::ComposerDraft {
            text: original_command.clone(),
            ..crate::ui::composer::ComposerDraft::default()
        };
        if self.agent.is_shared() {
            chat_view.set_status(Some(
                "External subagent commands require Embedded TUI; Shared TUI does not transport delegated command submissions"
                    .to_string(),
            ));
            chat_view.set_draft(submitted_draft);
            return;
        }
        if self
            .pending_session_operation
            .as_ref()
            .is_some_and(|pending| pending.session_id == chat_state.core_session_id)
        {
            chat_view.set_status(Some(
                "Waiting for the pending Session operation to finish before sending.".to_string(),
            ));
            chat_view.set_draft(submitted_draft);
            return;
        }
        if chat_state.is_processing {
            chat_state.add_system_message("Already processing, please wait.".to_string());
            chat_view.set_draft(submitted_draft);
            return;
        }
        if let Err(error) = self.materialize_requested_worktree(chat_view, chat_state, rt_handle) {
            tracing::error!("Failed to prepare worktree for delegated command: {error}");
            chat_view.set_status(Some(format!("Error: {error}")));
            chat_view.set_draft(submitted_draft);
            return;
        }

        let display_name = agent_display_name(&self.agent_type);
        chat_view.set_status(Some(format!("{} is delegating...", display_name)));
        let agent = self.agent.clone();
        let agent_type = self.agent_type.clone();
        match tokio::task::block_in_place(|| {
            rt_handle.block_on(agent.send_external_subagent_command(
                prompt,
                original_command,
                ecosystem_id,
                logical_id,
                &agent_type,
            ))
        }) {
            Ok(turn_id) => {
                tracing::info!("Started delegated command turn: {}", turn_id);
                chat_view.remember_submitted_draft(&chat_state.core_session_id, &submitted_draft);
            }
            Err(error) => {
                tracing::error!("Failed to delegate external command: {}", error);
                chat_view.set_status(Some(format!("Error: {error}")));
                chat_view.set_draft(submitted_draft);
            }
        }
    }

    fn send_draft_to_agent(
        &mut self,
        draft: crate::ui::composer::ComposerDraft,
        chat_view: &mut ChatView,
        chat_state: &mut ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) {
        if draft.has_images() && self.agent.is_shared() {
            chat_view.set_status(Some(crate::actions::shared_tui_image_attachment_error()));
            chat_view.set_draft(draft);
            return;
        }
        if self
            .pending_session_operation
            .as_ref()
            .is_some_and(|pending| pending.session_id == chat_state.core_session_id)
        {
            chat_view.set_status(Some(
                "Waiting for the pending Session operation to finish before sending.".to_string(),
            ));
            chat_view.set_draft(draft);
            return;
        }
        if chat_state.is_processing {
            chat_state.add_system_message("Already processing, please wait.".to_string());
            chat_view.set_draft(draft);
            return;
        }

        if let Err(error) = self.materialize_requested_worktree(chat_view, chat_state, rt_handle) {
            tracing::error!("Failed to prepare worktree for submitted prompt: {error}");
            chat_view.set_status(Some(format!("Error: {error}")));
            chat_state.add_system_message(error);
            chat_view.set_draft(draft);
            return;
        }

        let display_name = agent_display_name(&self.agent_type);
        chat_view.set_status(Some(format!("{} is thinking...", display_name)));

        let agent = self.agent.clone();
        let agent_type = self.agent_type.clone();
        let attachments = draft.runtime_attachments();
        match tokio::task::block_in_place(|| {
            rt_handle.block_on(agent.send_message_with_context(
                draft.text.clone(),
                draft.workspace_references.clone(),
                attachments,
                &agent_type,
            ))
        }) {
            Ok(turn_id) => {
                tracing::info!("Started turn: {}", turn_id);
                chat_view.remember_submitted_draft(&chat_state.core_session_id, &draft);
            }
            Err(e) => {
                tracing::error!("Failed to send message: {}", e);
                chat_view.set_status(Some(format!("Error: {}", e)));
                chat_view.set_draft(draft);
            }
        }
    }

    /// Show session selector popup with all available sessions
    fn show_session_selector(
        &self,
        chat_view: &mut ChatView,
        chat_state: &mut ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) {
        let agent = self.agent.clone();
        let current_session_id = chat_state.core_session_id.clone();
        let project_workspace = Some(agent.project_workspace_path_string());

        let sessions = tokio::task::block_in_place(|| rt_handle.block_on(agent.list_sessions()));
        let sessions = match sessions {
            Ok(sessions) => sessions,
            Err(error) => {
                tracing::error!("Failed to list sessions: {error}");
                chat_view.set_status(Some(format!("Failed to load sessions: {error}")));
                return;
            }
        };

        if sessions.is_empty() {
            chat_state.add_system_message("No sessions found.".to_string());
            return;
        }

        let session_items: Vec<SessionItem> = sessions
            .into_iter()
            .map(|s| {
                let last_activity = {
                    let last_activity =
                        std::time::UNIX_EPOCH + Duration::from_millis(s.last_active_at_ms);
                    let elapsed = last_activity.elapsed().unwrap_or_default();
                    if elapsed.as_secs() < 60 {
                        "just now".to_string()
                    } else if elapsed.as_secs() < 3600 {
                        format!("{}m ago", elapsed.as_secs() / 60)
                    } else if elapsed.as_secs() < 86400 {
                        format!("{}h ago", elapsed.as_secs() / 3600)
                    } else {
                        format!("{}d ago", elapsed.as_secs() / 86400)
                    }
                };
                SessionItem {
                    session_id: s.session_id,
                    session_name: s.session_name,
                    last_activity,
                    workspace: project_workspace.clone(),
                }
            })
            .collect();

        chat_view.show_session_selector(
            session_items,
            Some(current_session_id),
            session_delete_allowed(
                false,
                self.agent.is_shared(),
                chat_state.is_processing,
                self.pending_session_operation.is_some(),
            ),
        );
    }

    fn show_fork_selector(&self, chat_view: &mut ChatView, chat_state: &ChatState) {
        let points = chat_state.session_fork_points();
        if points.is_empty() {
            chat_view.set_status(Some(
                "No persisted prompts are available to fork.".to_string(),
            ));
            return;
        }
        chat_view.show_fork_selector(points);
        chat_view.set_status(Some(
            "Choose Full session or a prompt to fork immediately before it.".to_string(),
        ));
    }

    /// Handle session deletion from the session selector
    fn handle_session_delete(
        &mut self,
        item: &SessionItem,
        chat_view: &mut ChatView,
        chat_state: &mut ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) {
        let deleting_current_session = item.session_id == chat_state.core_session_id;
        if deleting_current_session {
            chat_view.set_status(Some("Cannot delete the active session".to_string()));
            return;
        }
        if !session_delete_allowed(
            deleting_current_session,
            self.agent.is_shared(),
            chat_state.is_processing,
            self.pending_session_operation.is_some(),
        ) {
            let message = if self.pending_session_operation.is_some() {
                "Another Session operation is already in progress. Please wait."
            } else {
                "Session deletion cannot start during the current Turn in Shared TUI."
            };
            chat_view.set_status(Some(message.to_string()));
            return;
        }

        let agent = self.agent.clone();
        let session_id = item.session_id.clone();
        let task_session_id = session_id.clone();
        let session_name = item.session_name.clone();
        chat_view.hide_session_selector();
        chat_view.set_status(Some(format!("Deleting session {session_name}...")));
        let handle = rt_handle.spawn(async move { agent.delete_session(&task_session_id).await });
        self.pending_session_operation = Some(PendingSessionOperation {
            session_id,
            kind: PendingSessionOperationKind::Delete { session_name },
            started_at: Instant::now(),
            slow_notice_shown: false,
            exit_warning_shown: false,
            handle,
        });
    }
}

fn session_delete_allowed(
    deleting_current_session: bool,
    shared_tui: bool,
    current_turn_active: bool,
    operation_pending: bool,
) -> bool {
    !deleting_current_session && !operation_pending && (!shared_tui || !current_turn_active)
}
