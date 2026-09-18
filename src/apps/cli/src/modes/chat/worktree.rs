#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WorktreeCommand {
    Toggle,
    Set(bool),
    Status,
}

fn parse_worktree_command(arguments: &str) -> std::result::Result<WorktreeCommand, String> {
    match arguments.trim().to_ascii_lowercase().as_str() {
        "" | "toggle" => Ok(WorktreeCommand::Toggle),
        "on" | "enable" => Ok(WorktreeCommand::Set(true)),
        "off" | "disable" => Ok(WorktreeCommand::Set(false)),
        "status" => Ok(WorktreeCommand::Status),
        _ => Err("Usage: /worktree [on|off|status|toggle]".to_string()),
    }
}

impl ChatMode {
    fn refresh_workspace_git_status(
        &self,
        chat_state: &mut ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) {
        let Some(workspace_path) = chat_state.workspace.clone() else {
            chat_state.set_worktree_control_available(false);
            chat_state.set_git_repository_status(false, None);
            return;
        };
        if self.agent.is_remote_workspace() {
            chat_state.set_worktree_control_available(false);
            chat_state.set_git_repository_status(false, None);
            tracing::debug!("Worktree management is unavailable for a Remote workspace");
            return;
        }

        let repository = tokio::task::block_in_place(|| {
            rt_handle.block_on(async {
                let repository =
                    openbitfun_core::service::git::GitService::resolve_worktree_repository(
                        &workspace_path,
                    )
                    .await?;
                openbitfun_core::service::git::GitService::get_repository_basic(
                    repository.query_path,
                )
                .await
            })
        });
        match repository {
            Ok(repository) => {
                chat_state.set_worktree_control_available(true);
                chat_state.set_git_repository_status(true, Some(repository.current_branch));
            }
            Err(error) => {
                chat_state.set_worktree_control_available(false);
                chat_state.set_git_repository_status(false, None);
                tracing::debug!("Worktree repository status is unavailable: {}", error);
            }
        }
    }

    fn worktree_status_message(chat_state: &ChatState) -> String {
        let workspace = chat_state.workspace.as_deref().unwrap_or("unavailable");
        let project_workspace = chat_state.project_workspace_path().unwrap_or("unavailable");
        format!(
            "Worktree: {}\nBranch: {}\nWorkspace: {}\nProject workspace: {}",
            chat_state.worktree_status_label(),
            chat_state.branch_label(),
            workspace,
            project_workspace
        )
    }

    /// Materialize the checkbox/slash-command preference only after the user
    /// has submitted a prompt. Keeping this next to the shared binding adapter
    /// gives interactive input, prompt commands, and future send paths one
    /// transition implementation.
    fn materialize_requested_worktree(
        &mut self,
        chat_view: &mut ChatView,
        chat_state: &mut ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) -> std::result::Result<(), String> {
        let Some(enabled) = chat_state.requested_worktree_enabled() else {
            return Ok(());
        };
        if enabled == chat_state.is_worktree_materialized() {
            chat_state.set_worktree_isolation_requested(None);
            return Ok(());
        }

        chat_view.set_status(Some(if enabled {
            "Creating worktree after prompt submission...".to_string()
        } else {
            "Releasing worktree after prompt submission...".to_string()
        }));
        let project_workspace_id = chat_state.project_workspace_id().map(str::to_string);
        let project_workspace_path = chat_state.project_workspace_path().map(str::to_string);
        if self.agent.is_remote_workspace() {
            return Err(
                "Worktree management is unavailable for a Remote workspace; the TUI does not fall back to controller-local services"
                    .to_string(),
            );
        }
        let result = tokio::task::block_in_place(|| {
            rt_handle.block_on(
                openbitfun_core::service::worktree::WorktreeService::bind_session(
                    openbitfun_core::service::worktree::WorktreeSessionBindingRequest {
                        request_id: format!("tui-worktree-{}", uuid::Uuid::new_v4()),
                        session_id: chat_state.core_session_id.clone(),
                        project_workspace_id,
                        project_workspace_path,
                        enabled,
                    },
                ),
            )
        })
        .map_err(|error| {
            format!(
                "Worktree isolation could not be prepared: {}: {}",
                match error.code {
                    openbitfun_runtime_ports::WorktreeErrorCode::RemoteUnsupported => {
                        "remote_unsupported"
                    }
                    _ => error.code.as_str(),
                },
                error.message
            )
        })?;

        let execution_target = result.execution_target.clone();
        let binding = openbitfun_runtime_ports::AgentSessionWorkspaceBinding {
            workspace_kind: Some(openbitfun_core::service::workspace::WorkspaceKind::Normal),
            project_workspace_id: result.project_workspace_id,
            workspace_id: result.workspace_id,
            workspace_path: result.workspace_path,
            project_workspace_path: Some(result.project_workspace_path),
            execution_target: Some(execution_target),
            remote_connection_id: None,
            remote_ssh_host: None,
        };
        self.agent.set_workspace_binding(&binding);
        chat_state.apply_workspace_binding(binding);
        chat_state.set_worktree_isolation_requested(None);
        self.workspace = chat_state.workspace.clone();
        self.refresh_workspace_git_status(chat_state, rt_handle);

        if let Some(path) = result.retained_worktree_path {
            chat_state.add_system_message(format!(
                "The released worktree was kept because it may contain local or unpublished work: {}",
                path
            ));
        }
        Ok(())
    }

    fn handle_worktree_command(
        &mut self,
        arguments: &str,
        chat_view: &mut ChatView,
        chat_state: &mut ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) -> Result<Option<ChatExitReason>> {
        let command = match parse_worktree_command(arguments) {
            Ok(command) => command,
            Err(usage) => {
                chat_view.set_status(Some(usage.clone()));
                chat_state.add_system_message(usage);
                return Ok(None);
            }
        };

        if command == WorktreeCommand::Status {
            self.refresh_workspace_git_status(chat_state, rt_handle);
            let message = Self::worktree_status_message(chat_state);
            chat_view.set_status(Some(chat_state.workspace_context_label()));
            chat_state.add_system_message(message);
            return Ok(None);
        }

        let action = action_by_id("toggle_worktree", ActionContext::Chat)
            .expect("Worktree action must remain registered");
        let state = ActionState::chat(chat_state.is_processing, false);
        if !action.available(state) {
            chat_view.set_status(Some(action.unavailable_message(state)));
            return Ok(None);
        }
        if !chat_state.worktree_control_available() {
            let message = "Worktree isolation is unavailable for the current workspace".to_string();
            chat_view.set_status(Some(message.clone()));
            chat_state.add_system_message(message);
            return Ok(None);
        }
        if chat_state.has_conversation_history() {
            let message =
                "Worktree isolation can only be changed before the session's first message"
                    .to_string();
            chat_view.set_status(Some(message.clone()));
            chat_state.add_system_message(message);
            return Ok(None);
        }

        let enabled = match command {
            WorktreeCommand::Toggle => !chat_state.is_worktree_enabled(),
            WorktreeCommand::Set(enabled) => enabled,
            WorktreeCommand::Status => unreachable!("status returned above"),
        };
        chat_state.set_worktree_isolation_requested(Some(enabled));
        let status = if enabled {
            "Worktree isolation armed; it will be created after the first prompt is submitted"
                .to_string()
        } else {
            "Worktree isolation disarmed; no Git work runs until a prompt is submitted".to_string()
        };
        chat_view.set_status(Some(format!(
            "{} ({})",
            status,
            chat_state.workspace_context_label()
        )));
        chat_state.add_system_message(format!(
            "{}.\n{}",
            status,
            Self::worktree_status_message(chat_state)
        ));

        Ok(None)
    }
}

#[cfg(test)]
mod worktree_tests {
    use super::{parse_worktree_command, WorktreeCommand};

    #[test]
    fn worktree_command_defaults_to_toggle() {
        assert_eq!(parse_worktree_command("").unwrap(), WorktreeCommand::Toggle);
        assert_eq!(
            parse_worktree_command("toggle").unwrap(),
            WorktreeCommand::Toggle
        );
    }

    #[test]
    fn worktree_command_accepts_explicit_states_and_status() {
        assert_eq!(
            parse_worktree_command("on").unwrap(),
            WorktreeCommand::Set(true)
        );
        assert_eq!(
            parse_worktree_command("disable").unwrap(),
            WorktreeCommand::Set(false)
        );
        assert_eq!(
            parse_worktree_command("STATUS").unwrap(),
            WorktreeCommand::Status
        );
        assert!(parse_worktree_command("create").is_err());
    }
}
