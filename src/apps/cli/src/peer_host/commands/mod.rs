//! Product HostInvoke command handlers for CLI Peer Host.

mod config;
mod dialog;
mod external_sources;
mod filesystem;
mod git;
mod permission;
mod product_control;
mod session;
mod snapshot;
mod soft;
mod system;
mod tools;
mod workspace;

use serde_json::Value;

use super::state::PeerHostState;

pub(crate) async fn dispatch(
    command: &str,
    args: &Value,
    state: &PeerHostState,
) -> Result<Value, String> {
    match command {
        // Workspace / config
        "initialize_workspace_startup_state" => {
            workspace::initialize_workspace_startup_state(state).await
        }
        "get_opened_workspaces" => workspace::get_opened_workspaces(state).await,
        "get_recent_workspaces" => workspace::get_recent_workspaces(state).await,
        "get_current_workspace" | "get_workspace_info" => {
            workspace::get_current_workspace(state).await
        }
        "open_workspace" => workspace::open_workspace(state, args).await,
        "cleanup_invalid_workspaces" => workspace::cleanup_invalid_workspaces(state).await,
        "reload_config" => workspace::reload_config().await,
        "get_config" => config::get_config(args).await,
        "get_configs" => config::get_configs(args).await,
        "set_config" => config::set_config(state, args).await,
        "get_web_search_credential_status" => config::get_web_search_credential_status(args).await,
        "save_web_search_credential" => config::save_web_search_credential(args).await,
        "clear_web_search_credential" => config::clear_web_search_credential(args).await,
        "product_control_invoke" => product_control::invoke(state, args).await,
        "get_agent_profile_config" => config::get_agent_profile_config(args).await,
        "get_agent_profile_configs" => config::get_agent_profile_configs().await,
        "get_external_source_snapshot"
        | "get_external_source_control_snapshot"
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
            external_sources::dispatch(command, args, state).await
        }

        // Filesystem
        "get_directory_children" | "list_files" => {
            filesystem::get_directory_children(state, args).await
        }
        "get_directory_children_paginated" => {
            filesystem::get_directory_children_paginated(state, args).await
        }
        "check_path_exists" => filesystem::check_path_exists(args).await,
        "create_directory" => filesystem::create_directory(state, args).await,

        // Tools catalog — read-only tool listing for Agents / Assistant
        // Defaults UI. CLI Host assembles the same Core tool registry as
        // Desktop and returns the identical DTO shape, so a controller cannot
        // tell "CLI Host doesn't support catalog query" from "the runtime
        // really has no tools". Without this the call fell into the unsupported
        // dispatch branch and the UI silently rendered an empty tool list.
        "get_all_tools_info" => tools::get_all_tools_info().await,
        "get_chat_mcp_catalog" => tools::get_chat_mcp_catalog(args).await,

        // Sessions
        "list_persisted_sessions" => session::list_persisted_sessions(state, args).await,
        "list_persisted_sessions_page" => session::list_persisted_sessions_page(state, args).await,
        "save_session_metadata" => session::save_session_metadata(state, args).await,
        "list_persisted_sessions_count" => {
            session::list_persisted_sessions_count(state, args).await
        }
        "search_session_content" => session::search_session_content(state, args).await,
        "load_session_turn_window" => session::load_session_turn_window(state, args).await,
        "load_session_turns" => session::load_session_turns(state, args).await,
        "load_session_event_backfill" => session::load_session_event_backfill(state, args),
        "restore_session_view" => session::restore_session_view(state, args).await,
        "restore_session_with_turns" => session::restore_session_with_turns(state, args).await,
        "restore_session" => session::restore_session(state, args).await,
        "create_session" => session::create_session(state, args).await,
        "delete_session" => session::delete_session(state, args).await,
        "rename_session" => session::rename_session(state, args).await,
        "archive_session" => session::archive_session(state, args).await,
        "touch_session_activity" => session::touch_session_activity(state, args).await,
        "get_session_thread_goal" => session::get_session_thread_goal(state, args).await,
        "update_session_mode" => session::update_session_mode(state, args).await,
        "update_session_model" => session::update_session_model(state, args).await,
        "ensure_coordinator_session" => session::ensure_coordinator_session(state, args).await,
        "get_available_modes" => session::get_available_modes(state, args).await,
        "get_session_stats" => session::get_session_stats(state, args).await,
        "save_session_turn" => session::save_session_turn(state, args).await,

        // Snapshot / rollback
        "rollback_session_to_turn" => snapshot::rollback_session_to_turn(state, args).await,
        "get_session_files" => snapshot::get_session_files(state, args).await,

        // Dialog / tools
        "start_dialog_turn" => dialog::start_dialog_turn(state, args).await,
        "cancel_dialog_turn" => dialog::cancel_dialog_turn(state, args).await,
        "submit_user_answers" => dialog::submit_user_answers(state, args).await,
        // Per-tool interrupt. The controller renders Terminal cards for Turns
        // this host owns, so it must be able to stop a running tool here —
        // same owner as cancel_dialog_turn, one level finer. Reaches the Core
        // coordinator via the compatibility surface both CLI and Desktop Peer
        // Hosts share.
        "cancel_tool" => dialog::cancel_tool(state, args).await,
        "list_pending_permission_requests" => permission::list_pending_permission_requests(state),
        "subscribe_permission_requests" => permission::subscribe_permission_requests(),
        "respond_permission" => permission::respond_permission(state, args).await,
        "respond_permission_batch" => permission::respond_permission_batch(state, args).await,
        "list_project_permission_grants" => {
            permission::list_project_permission_grants(state, args).await
        }
        "remove_project_permission_grant" => {
            permission::remove_project_permission_grant(state, args).await
        }
        "clear_project_permission_grants" => {
            permission::clear_project_permission_grants(state, args).await
        }
        "list_project_permission_audit" => {
            permission::list_project_permission_audit(state, args).await
        }

        // Git (local workspace only)
        "git_is_repository" => git::git_is_repository(args).await,
        "git_get_repository_trust" => git::git_get_repository_trust(args).await,

        // Soft empty / no-op for Desktop-only subsystems
        "notify_cron_host_ready" => soft::notify_cron_host_ready().await,
        "list_miniapps" => soft::list_miniapps().await,
        "miniapp_worker_list_running" => soft::miniapp_worker_list_running().await,
        "get_acp_clients" => soft::get_acp_clients().await,
        "list_background_command_activities" => soft::list_background_command_activities().await,

        // System
        "get_system_info" => system::get_system_info().await,
        "get_token_usage_statistics" => system::get_token_usage_statistics(state, args).await,

        // Only reachable if the registry marks a command Handled without a
        // matching arm above; the closure test below fails first.
        other => Err(format!(
            "command '{other}' is registered as handled on the CLI peer host but this build has no handler for it"
        )),
    }
}

/// Product commands the `dispatch` match above answers with a real handler.
/// The closure tests below keep this list, the match arms, and the Product
/// Operation Registry's `cli_peer == Handled` rows identical, so a command
/// cannot be advertised as runnable here without a handler (or vice versa).
#[cfg(test)]
pub(crate) const HANDLED_COMMANDS: &[&str] = &[
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
    "get_directory_children",
    "get_directory_children_paginated",
    "get_external_source_control_snapshot",
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
    "start_dialog_turn",
    "submit_user_answers",
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
            .find("other => Err(")
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
            let is_soft = target.starts_with("soft::");
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
