//! Product HostInvoke command handlers for CLI Peer Host.

mod config;
mod dialog;
mod external_sources;
mod filesystem;
mod git;
mod models;
mod permission;
mod product_control;
mod session;
mod snapshot;
mod soft;
mod system;
mod terminal;
mod tools;
mod workspace;

use serde_json::Value;

use super::state::PeerHostState;

// Select the handler before polling it. A monolithic async match retains every
// handler's construction temporaries in its poll frame (900 KiB in a debug
// build), exhausting the worker stack when a handler starts the runtime.
// Returning a selected future releases dispatch's stack before execution.
pub(crate) fn dispatch<'a>(
    command: &'a str,
    args: &'a Value,
    state: &'a PeerHostState,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value, String>> + Send + 'a>> {
    match command {
        "list_ai_models_by_config" => Box::pin(models::list_ai_models_by_config(args)),
        "list_visible_subagents" | "list_subagents" | "list_manageable_subagents" => Box::pin(tools::list_subagents(command, args)),
        "get_session_permission_mode" => Box::pin(permission::session_permission_mode(state, args, false, false)),
        "update_session_permission_mode" => Box::pin(permission::session_permission_mode(state, args, true, false)),
        "update_active_turn_permission_mode" => Box::pin(permission::session_permission_mode(state, args, true, true)),
        "get_ai_model_catalog" => Box::pin(models::get_ai_model_catalog()),
        "project_ai_model_reasoning_catalog" => Box::pin(models::project_ai_model_reasoning_catalog(args)),
        "get_model_configs" => Box::pin(models::get_model_configs()),
        "get_models_dev_catalog_status" => Box::pin(models::get_models_dev_catalog_status()),
        "refresh_models_dev_catalog_now" => Box::pin(models::refresh_models_dev_catalog_now()),
        "test_ai_config_connection" => Box::pin(models::test_ai_config_connection(args)),
        // Workspace / config
        "initialize_workspace_startup_state" => {
            Box::pin(workspace::initialize_workspace_startup_state(state))
        }
        "get_opened_workspaces" => Box::pin(workspace::get_opened_workspaces(state)),
        "get_recent_workspaces" => Box::pin(workspace::get_recent_workspaces(state)),
        "get_current_workspace" | "get_workspace_info" => {
            Box::pin(workspace::get_current_workspace(state))
        }
        "set_active_workspace" => Box::pin(workspace::set_active_workspace(state, args)),
        "open_workspace" => Box::pin(workspace::open_workspace(state, args)),
        "ssh_list_saved_connections" => Box::pin(workspace::ssh_list_saved_connections()),
        "open_remote_workspace" => Box::pin(workspace::open_remote_workspace(state, args)),
        "cleanup_invalid_workspaces" => Box::pin(workspace::cleanup_invalid_workspaces(state)),
        "reload_config" => Box::pin(workspace::reload_config()),
        "get_config" => Box::pin(config::get_config(args)),
        "get_configs" => Box::pin(config::get_configs(args)),
        "set_config" => Box::pin(config::set_config(state, args)),
        "get_web_search_credential_status" => Box::pin(config::get_web_search_credential_status(args)),
        "save_web_search_credential" => Box::pin(config::save_web_search_credential(args)),
        "clear_web_search_credential" => Box::pin(config::clear_web_search_credential(args)),
        "product_control_invoke" => Box::pin(product_control::invoke(state, args)),
        "get_agent_profile_config" => Box::pin(config::get_agent_profile_config(args)),
        "get_agent_profile_configs" => Box::pin(config::get_agent_profile_configs()),
        "get_external_source_snapshot"
        | "get_external_source_control_snapshot"
        | "get_external_source_discovery_snapshot"
        | "reveal_external_source_location"
        | "apply_external_source_control_action_command"
        | "set_external_source_enabled_command"
        | "set_external_source_conflict_choice_command"
        | "set_external_tool_target_decision_command"
        | "set_external_tool_targets_enabled_command"
        | "set_external_tool_conflict_choice_command"
        | "set_external_subagent_activation_command"
        | "set_external_subagents_enabled_command"
        | "set_external_subagent_model_binding_command"
        | "choose_external_subagent_conflict_command"
        | "set_external_mcp_server_decision_command"
        | "set_external_mcp_servers_enabled_command"
        | "choose_external_mcp_conflict_command"
        | "update_external_integration_policy_command" => {
            Box::pin(external_sources::dispatch(command, args, state))
        }

        "terminal_execute" => Box::pin(terminal::execute(args)),
        "terminal_create" => Box::pin(terminal::create(state, args)),
        "terminal_write" => Box::pin(terminal::write(args)),
        "terminal_resize" => Box::pin(terminal::resize(args)),
        "terminal_close" => Box::pin(terminal::close(args)),
        "terminal_get_history" => Box::pin(terminal::history(args)),
        "terminal_list" => Box::pin(terminal::list()),
        "terminal_get" => Box::pin(terminal::get(args)),
        "terminal_get_shells" => Box::pin(terminal::shells()),
        "terminal_signal" => Box::pin(terminal::signal(args)),
        "terminal_ack" => Box::pin(terminal::acknowledge(args)),
        "terminal_has_shell_integration" => Box::pin(terminal::has_shell_integration(args)),
        "terminal_send_command" => Box::pin(terminal::send_command(args)),
        "terminal_shutdown_all" => Box::pin(terminal::shutdown_all()),
        // Filesystem
        "workspace_file_upload" => Box::pin(filesystem::workspace_file_upload(state, args)),
        "get_directory_children" | "list_files" => {
            Box::pin(filesystem::get_directory_children(state, args))
        }
        "get_directory_children_paginated" => {
            Box::pin(filesystem::get_directory_children_paginated(state, args))
        }
        "check_path_exists" => Box::pin(filesystem::check_path_exists(state, args)),
        "create_directory" => Box::pin(filesystem::create_directory(state, args)),
        "read_file_content" => Box::pin(filesystem::read_file_content(state, args)),
        "write_file_content" => Box::pin(filesystem::write_file_content(state, args)),
        "rename_file" => Box::pin(filesystem::rename_file(state, args)),
        "delete_file" => Box::pin(filesystem::delete_path(state, args, false)),
        "delete_directory" => Box::pin(filesystem::delete_path(state, args, true)),
        "list_directory_files" => Box::pin(filesystem::list_directory_files(state, args)),

        // Tools catalog — read-only tool listing for Agents / Assistant
        // Defaults UI. CLI Host assembles the same Core tool registry as
        // Desktop and returns the identical DTO shape, so a controller cannot
        // tell "CLI Host doesn't support catalog query" from "the runtime
        // really has no tools". Without this the call fell into the unsupported
        // dispatch branch and the UI silently rendered an empty tool list.
        "get_all_tools_info" => Box::pin(tools::get_all_tools_info()),
        "get_chat_mcp_catalog" => Box::pin(tools::get_chat_mcp_catalog(args)),

        // Sessions
        "list_persisted_sessions" => Box::pin(session::list_persisted_sessions(state, args)),
        "list_persisted_sessions_page" => Box::pin(session::list_persisted_sessions_page(state, args)),
        "save_session_metadata" => Box::pin(session::save_session_metadata(state, args)),
        "list_persisted_sessions_count" => {
            Box::pin(session::list_persisted_sessions_count(state, args))
        }
        "search_session_content" => Box::pin(session::search_session_content(state, args)),
        "load_session_turn_window" => Box::pin(session::load_session_turn_window(state, args)),
        "load_session_turns" => Box::pin(session::load_session_turns(state, args)),
        "load_session_event_backfill" => Box::pin(std::future::ready(session::load_session_event_backfill(state, args))),
        "restore_session_view" => Box::pin(session::restore_session_view(state, args)),
        "restore_session_with_turns" => Box::pin(session::restore_session_with_turns(state, args)),
        "restore_session" => Box::pin(session::restore_session(state, args)),
        "ensure_control_conversation" => Box::pin(session::ensure_control_conversation(state, args)),
        "create_control_conversation" => Box::pin(session::create_control_conversation(state, args)),
        "record_voice_exchange" => Box::pin(session::record_voice_exchange(state, args)),
        "create_session" => Box::pin(session::create_session(state, args)),
        "delete_session" => Box::pin(session::delete_session(state, args)),
        "rename_session" => Box::pin(session::rename_session(state, args)),
        "archive_session" => Box::pin(session::archive_session(state, args)),
        "touch_session_activity" => Box::pin(session::touch_session_activity(state, args)),
        "get_session_thread_goal" => Box::pin(session::get_session_thread_goal(state, args)),
        "update_session_mode" => Box::pin(session::update_session_mode(state, args)),
        "update_session_model" => Box::pin(session::update_session_model(state, args)),
        "ensure_coordinator_session" => Box::pin(session::ensure_coordinator_session(state, args)),
        "get_available_modes" => Box::pin(session::get_available_modes(state, args)),
        "get_session_stats" => Box::pin(session::get_session_stats(state, args)),
        "save_session_turn" => Box::pin(session::save_session_turn(state, args)),

        // Snapshot / rollback
        "rollback_session_to_turn" => Box::pin(snapshot::rollback_session_to_turn(state, args)),
        "get_session_files" => Box::pin(snapshot::get_session_files(state, args)),

        // Dialog / tools
        "start_dialog_turn" => Box::pin(dialog::start_dialog_turn(state, args)),
        "cancel_dialog_turn" => Box::pin(dialog::cancel_dialog_turn(state, args)),
        "start_user_question_interaction" => Box::pin(dialog::start_user_question_interaction(state, args)),
        "submit_user_answers" => Box::pin(dialog::submit_user_answers(state, args)),
        // Per-tool interrupt. The controller renders Terminal cards for Turns
        // this host owns, so it must be able to stop a running tool here —
        // same owner as cancel_dialog_turn, one level finer. Reaches the Core
        // coordinator via the compatibility surface both CLI and Desktop Peer
        // Hosts share.
        "cancel_tool" => Box::pin(dialog::cancel_tool(state, args)),
        "get_session_interaction_mailbox" => Box::pin(std::future::ready(permission::get_session_interaction_mailbox(state, args))),
        "list_pending_permission_requests" => Box::pin(std::future::ready(permission::list_pending_permission_requests(state))),
        "subscribe_permission_requests" => Box::pin(std::future::ready(permission::subscribe_permission_requests())),
        "respond_permission" => Box::pin(permission::respond_permission(state, args)),
        "respond_permission_batch" => Box::pin(permission::respond_permission_batch(state, args)),
        "list_project_permission_grants" => {
            Box::pin(permission::list_project_permission_grants(state, args))
        }
        "remove_project_permission_grant" => {
            Box::pin(permission::remove_project_permission_grant(state, args))
        }
        "clear_project_permission_grants" => {
            Box::pin(permission::clear_project_permission_grants(state, args))
        }
        "list_project_permission_audit" => {
            Box::pin(permission::list_project_permission_audit(state, args))
        }

        // Git (local workspace only)
        "git_is_repository" => Box::pin(git::git_is_repository(args)),
        "git_get_repository_trust" => Box::pin(git::git_get_repository_trust(args)),

        // Soft empty / no-op for Desktop-only subsystems
        "notify_cron_host_ready" => Box::pin(soft::notify_cron_host_ready()),
        "list_miniapps" => Box::pin(soft::list_miniapps()),
        "miniapp_worker_list_running" => Box::pin(soft::miniapp_worker_list_running()),
        "get_acp_clients" => Box::pin(soft::get_acp_clients()),
        "list_background_command_activities" => Box::pin(soft::list_background_command_activities()),

        // System
        "get_system_info" => Box::pin(system::get_system_info()),
        "get_token_usage_statistics" => Box::pin(system::get_token_usage_statistics(state, args)),

        // Only reachable if the registry marks a command Handled without a
        // matching arm above; the closure test below fails first.
        other => Box::pin(std::future::ready(Err(format!(
            "command '{other}' is registered as handled on the CLI peer host but this build has no handler for it"
        )))),
    }
}

/// Product commands the `dispatch` match above answers with a real handler.
/// The closure tests below keep this list, the match arms, and the Product
/// Operation Registry's `cli_peer == Handled` rows identical, so a command
/// cannot be advertised as runnable here without a handler (or vice versa).
#[cfg(test)]
pub(crate) const HANDLED_COMMANDS: &[&str] = &[
    "terminal_execute",
    "terminal_get",
    "terminal_get_shells",
    "terminal_signal",
    "terminal_ack",
    "terminal_has_shell_integration",
    "terminal_send_command",
    "terminal_shutdown_all",
    "terminal_create",
    "terminal_write",
    "terminal_resize",
    "terminal_close",
    "terminal_get_history",
    "terminal_list",
    "ssh_list_saved_connections",
    "open_remote_workspace",
    "read_file_content",
    "write_file_content",
    "rename_file",
    "delete_file",
    "delete_directory",
    "list_directory_files",
    "list_subagents",
    "list_manageable_subagents",
    "test_ai_config_connection",
    "refresh_models_dev_catalog_now",
    "get_models_dev_catalog_status",
    "get_model_configs",
    "project_ai_model_reasoning_catalog",
    "get_ai_model_catalog",
    "update_active_turn_permission_mode",
    "update_session_permission_mode",
    "get_session_permission_mode",
    "list_visible_subagents",
    "list_ai_models_by_config",
    "apply_external_source_control_action_command",
    "archive_session",
    "cancel_dialog_turn",
    "cancel_tool",
    "check_path_exists",
    "choose_external_mcp_conflict_command",
    "choose_external_subagent_conflict_command",
    "cleanup_invalid_workspaces",
    "clear_project_permission_grants",
    "clear_web_search_credential",
    "create_directory",
    "create_session",
    "ensure_control_conversation",
    "create_control_conversation",
    "record_voice_exchange",
    "delete_session",
    "ensure_coordinator_session",
    "get_agent_profile_config",
    "get_agent_profile_configs",
    "get_all_tools_info",
    "get_chat_mcp_catalog",
    "get_available_modes",
    "get_config",
    "get_configs",
    "get_current_workspace",
    "workspace_file_upload",
    "get_directory_children",
    "get_directory_children_paginated",
    "get_external_source_control_snapshot",
    "get_external_source_discovery_snapshot",
    "get_external_source_snapshot",
    "get_opened_workspaces",
    "get_recent_workspaces",
    "get_session_files",
    "get_session_stats",
    "get_session_thread_goal",
    "get_system_info",
    "get_token_usage_statistics",
    "get_web_search_credential_status",
    "get_workspace_info",
    "git_get_repository_trust",
    "git_is_repository",
    "initialize_workspace_startup_state",
    "list_files",
    "get_session_interaction_mailbox",
    "list_pending_permission_requests",
    "list_persisted_sessions",
    "list_persisted_sessions_count",
    "list_persisted_sessions_page",
    "list_project_permission_audit",
    "list_project_permission_grants",
    "load_session_event_backfill",
    "load_session_turn_window",
    "load_session_turns",
    "open_workspace",
    "product_control_invoke",
    "reload_config",
    "remove_project_permission_grant",
    "rename_session",
    "respond_permission",
    "respond_permission_batch",
    "restore_session",
    "restore_session_view",
    "restore_session_with_turns",
    "reveal_external_source_location",
    "rollback_session_to_turn",
    "save_session_metadata",
    "save_session_turn",
    "save_web_search_credential",
    "search_session_content",
    "set_config",
    "set_external_mcp_server_decision_command",
    "set_external_mcp_servers_enabled_command",
    "set_external_source_conflict_choice_command",
    "set_external_source_enabled_command",
    "set_external_subagent_activation_command",
    "set_external_subagent_model_binding_command",
    "set_external_subagents_enabled_command",
    "set_external_tool_conflict_choice_command",
    "set_external_tool_target_decision_command",
    "set_external_tool_targets_enabled_command",
    "set_active_workspace",
    "start_dialog_turn",
    "submit_user_answers",
    "start_user_question_interaction",
    "subscribe_permission_requests",
    "touch_session_activity",
    "update_external_integration_policy_command",
    "update_session_mode",
    "update_session_model",
];

/// Commands answered by `soft.rs` with a declared empty or no-op success.
#[cfg(test)]
pub(crate) const SOFT_EMPTY_COMMANDS: &[&str] = &[
    "get_acp_clients",
    "list_background_command_activities",
    "list_miniapps",
    "miniapp_worker_list_running",
    "notify_cron_host_ready",
];

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::{HANDLED_COMMANDS, SOFT_EMPTY_COMMANDS};

    /// Parses the string arms of the `dispatch` match in this file and splits
    /// them by whether they route to `soft::`. The match body ends at the
    /// catch-all `other =>` arm, so the test module below is never scanned.
    fn dispatch_arms() -> (BTreeSet<String>, BTreeSet<String>) {
        let source = include_str!("mod.rs");
        let start = source
            .find("match command {")
            .expect("commands::dispatch must match on the command name");
        let end = source[start..]
            .find("other =>")
            .map(|offset| start + offset)
            .expect("commands::dispatch must end with the `other =>` arm");
        let body = &source[start..end];
        let mut handled = BTreeSet::new();
        let mut soft = BTreeSet::new();
        // Arms may span lines (`"a" | "b" => { module::f(..) }`), so scan
        // token-wise: quoted names accumulate until the next `module::` target.
        let mut pending: Vec<String> = Vec::new();
        for raw in body.lines() {
            let line = raw.trim();
            if line.starts_with("//") || line.is_empty() {
                continue;
            }
            let mut rest = line;
            while let Some(open) = rest.find('"') {
                let after = &rest[open + 1..];
                let Some(close) = after.find('"') else { break };
                pending.push(after[..close].to_string());
                rest = &after[close + 1..];
            }
            let target = match line.find("=>") {
                Some(arrow) => line[arrow + 2..].trim(),
                None => line,
            };
            let target = target.trim_start_matches('{').trim();
            if pending.is_empty() || !target.contains("::") {
                continue;
            }
            let is_soft = target.trim_start_matches("Box::pin(").starts_with("soft::");
            for name in pending.drain(..) {
                if is_soft {
                    soft.insert(name);
                } else {
                    handled.insert(name);
                }
            }
        }
        assert!(
            pending.is_empty(),
            "unclassified dispatch arms: {pending:?}"
        );
        (handled, soft)
    }

    fn as_set(list: &[&str]) -> BTreeSet<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn handled_commands_match_dispatch_arms() {
        let (handled, soft) = dispatch_arms();
        assert!(
            handled.len() > 50,
            "dispatch arm parsing looks broken: {}",
            handled.len()
        );
        assert_eq!(
            handled,
            as_set(HANDLED_COMMANDS),
            "HANDLED_COMMANDS must list exactly the match arms"
        );
        assert_eq!(
            soft,
            as_set(SOFT_EMPTY_COMMANDS),
            "SOFT_EMPTY_COMMANDS must list exactly the soft:: arms"
        );
    }

    #[test]
    fn handled_commands_match_registry() {
        use openbitfun_product_domains::remote_surface::{
            cli_handled_commands, soft_empty_commands,
        };
        let registry_handled: BTreeSet<String> = cli_handled_commands()
            .into_iter()
            .map(String::from)
            .collect();
        assert_eq!(
            registry_handled,
            as_set(HANDLED_COMMANDS),
            "registry rows with cli_peer == Handled must equal the CLI dispatch table; \
             add or remove the row in product-domains remote_surface/table.rs together with the handler"
        );
        let registry_soft: BTreeSet<String> = soft_empty_commands()
            .into_iter()
            .map(String::from)
            .collect();
        assert_eq!(
            registry_soft,
            as_set(SOFT_EMPTY_COMMANDS),
            "registry SoftEmpty rows must equal the soft:: dispatch arms"
        );
    }
}
