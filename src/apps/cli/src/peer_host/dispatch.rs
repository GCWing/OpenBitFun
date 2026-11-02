//! HostInvoke / DeviceEvent dispatch for CLI Peer Host.

use openbitfun_core_types::agent_identity_wire::{
    translate_agent_identity_command, translate_agent_identity_response, AgentIdentityDialect,
};

use serde_json::{json, Value};

use openbitfun_core::service::remote_connect::remote_server::RemoteResponse;

use super::commands;
use super::control::{
    attach_controller, detach_controller, parse_controller_device_id, peer_mode_ping_value,
};
use super::state::peer_host_state;
use openbitfun_product_domains::remote_surface::{
    peer_host_verdict, PeerHostKind, PeerHostVerdict,
};

#[derive(Debug, Clone)]
struct HostInvokeBridgeResult {
    ok: bool,
    value: Option<Value>,
    error: Option<String>,
}

impl HostInvokeBridgeResult {
    fn ok_value(value: Value) -> Self {
        Self {
            ok: true,
            value: Some(value),
            error: None,
        }
    }

    fn err(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            value: None,
            error: Some(message.into()),
        }
    }

    fn into_remote_response(self) -> RemoteResponse {
        RemoteResponse::HostInvokeResult {
            ok: self.ok,
            value: self.value,
            error: self.error,
        }
    }
}

/// Handle `RemoteCommand::HostInvoke` and return a HostInvokeResult envelope.
pub(crate) async fn handle_host_invoke(command: &str, args: Value) -> RemoteResponse {
    handle_host_invoke_inner(command, args)
        .await
        .into_remote_response()
}

async fn handle_host_invoke_inner(command: &str, args: Value) -> HostInvokeBridgeResult {
    // The Product Operation Registry decides what this host may run on a
    // controller's behalf. The verdict order (empty, retired, control plane,
    // controller-owned, unsupported here, execute, unknown) is the registry's,
    // shared with the desktop peer host and the generated frontend tables.
    match peer_host_verdict(command, PeerHostKind::Cli) {
        PeerHostVerdict::Refuse(refusal) => {
            return HostInvokeBridgeResult::err(refusal.message(command));
        }
        PeerHostVerdict::HostControlPlane => return handle_control_plane(command, args).await,
        PeerHostVerdict::Execute => {}
    }

    let state = match peer_host_state() {
        Ok(s) => s,
        Err(e) => return HostInvokeBridgeResult::err(e),
    };

    let args =
        match translate_agent_identity_command(command, args, AgentIdentityDialect::Canonical) {
            Ok(args) => args,
            Err(error) => return HostInvokeBridgeResult::err(error),
        };
    match commands::dispatch(command, &args, state).await {
        Ok(value) => match translate_agent_identity_response(
            command,
            value,
            &args,
            AgentIdentityDialect::Legacy,
        ) {
            Ok(value) => HostInvokeBridgeResult::ok_value(value),
            Err(error) => HostInvokeBridgeResult::err(error),
        },
        Err(error) => HostInvokeBridgeResult::err(error),
    }
}

/// Control-plane commands are answered before any product dispatch and never
/// acquire a Peer controller lease for a product command.
async fn handle_control_plane(command: &str, args: Value) -> HostInvokeBridgeResult {
    // Detached dispatch is target-owned. Route the distinct target command
    // family directly to the durable CLI runner.
    if let Some(verb) = dispatch_target_verb(command) {
        return match crate::dispatch::run_dispatch_verb(verb, args).await {
            Ok(value) => HostInvokeBridgeResult::ok_value(value),
            Err(error) => HostInvokeBridgeResult::err(format!("{error:#}")),
        };
    }

    // Same special-case path as desktop execute_local_remote_command.
    match command {
        "peer_control_attach" => {
            let controller_id = parse_controller_device_id(&args);
            if controller_id.trim().is_empty() {
                return HostInvokeBridgeResult::err("controller_device_id is required");
            }
            if let Err(error) = attach_controller(controller_id).await {
                return HostInvokeBridgeResult::err(error);
            }
            HostInvokeBridgeResult::ok_value(json!({ "attached": true }))
        }
        "peer_control_detach" => {
            let controller_id = parse_controller_device_id(&args);
            detach_controller(&controller_id).await;
            HostInvokeBridgeResult::ok_value(json!({ "detached": true }))
        }
        "peer_mode_ping" => HostInvokeBridgeResult::ok_value(peer_mode_ping_value()),
        other => HostInvokeBridgeResult::err(format!(
            "command '{other}' is registered as peer host control plane but this CLI build has no handler for it"
        )),
    }
}

fn dispatch_target_verb(command: &str) -> Option<&'static str> {
    match command {
        "dispatch_target_probe" => Some("probe"),
        "dispatch_target_submit" => Some("submit"),
        "dispatch_target_status" => Some("status"),
        "dispatch_target_cancel" => Some("cancel"),
        "dispatch_target_list" => Some("list"),
        "dispatch_target_answer" => Some("answer"),
        "dispatch_target_append" => Some("append"),
        "dispatch_target_continue" => Some("continue"),
        "dispatch_target_query" => Some("query"),
        "dispatch_target_workspace_provision" => Some("workspace-provision"),
        "dispatch_target_workspace_bundle_begin" => Some("workspace-bundle-begin"),
        "dispatch_target_workspace_bundle_chunk" => Some("workspace-bundle-chunk"),
        "dispatch_target_workspace_bundle_commit" => Some("workspace-bundle-commit"),
        "dispatch_target_workspace_sync" => Some("workspace-sync"),
        "dispatch_target_workspace_sync_chunk" => Some("workspace-sync-chunk"),
        _ => None,
    }
}

/// Peer-side DeviceEvent is a no-op ack (controller is the consumer).
pub(crate) fn handle_device_event_command() -> RemoteResponse {
    RemoteResponse::DeviceEventAccepted
}

#[cfg(test)]
mod tests {
    use super::super::deny::{is_cli_unsupported_command, is_local_only_command};
    use super::*;

    #[tokio::test]
    async fn peer_mode_ping_returns_ok_peer_payload() {
        let resp = handle_host_invoke("peer_mode_ping", json!({})).await;
        match resp {
            RemoteResponse::HostInvokeResult {
                ok: true,
                value: Some(value),
                error: None,
            } => {
                assert_eq!(value.get("ok"), Some(&json!(true)));
                assert_eq!(value.get("peer"), Some(&json!(true)));
                assert!(value.get("device_id").and_then(|v| v.as_str()).is_some());
                assert_eq!(
                    value.pointer("/capabilities/targeted_session_rollback"),
                    Some(&json!(true))
                );
                assert_eq!(
                    value.pointer("/capabilities/token_usage_statistics"),
                    Some(&json!(true))
                );
                assert_eq!(
                    value.pointer("/capabilities/product_control_v1"),
                    Some(&json!(true))
                );
                assert_eq!(
                    value.pointer("/capabilities/cancel_tool"),
                    Some(&json!(true))
                );
                assert_eq!(
                    value.pointer("/capabilities/tool_catalog"),
                    Some(&json!(true))
                );
                assert_eq!(
                    value.pointer("/capabilities/user_question_response"),
                    Some(&json!(true))
                );
            }
            other => panic!("unexpected response: {other:?}"),
        }
    }

    #[tokio::test]
    async fn peer_mode_ping_advertises_cli_host_type() {
        // An older CLI did not advertise `cancel_tool`/`tool_catalog`; the
        // `host_type: "cli"` field lets the controller resolve those missing
        // capabilities as unsupported instead of optimistically invoking a
        // command the CLI never implemented. See PR #2428 round 5 #1.
        let resp = handle_host_invoke("peer_mode_ping", json!({})).await;
        match resp {
            RemoteResponse::HostInvokeResult {
                ok: true,
                value: Some(value),
                error: None,
            } => {
                assert_eq!(value.get("host_type").and_then(|v| v.as_str()), Some("cli"));
            }
            other => panic!("unexpected response: {other:?}"),
        }
    }

    #[tokio::test]
    async fn local_only_commands_are_denied() {
        let resp = handle_host_invoke("account_logout", json!({})).await;
        match resp {
            RemoteResponse::HostInvokeResult {
                ok: false,
                error: Some(err),
                ..
            } => {
                assert!(err.contains("local-only"));
            }
            other => panic!("unexpected response: {other:?}"),
        }
    }

    #[tokio::test]
    async fn retired_lsp_commands_fail_before_peer_state_or_command_dispatch() {
        let resp = handle_host_invoke("lsp_open_workspace", json!({})).await;
        match resp {
            RemoteResponse::HostInvokeResult {
                ok: false,
                value: None,
                error: Some(err),
            } => {
                assert_eq!(
                    err,
                    "command 'lsp_open_workspace' is unsupported because the OpenBitFun LSP runtime has been retired"
                );
            }
            other => panic!("unexpected response: {other:?}"),
        }
    }

    #[test]
    fn detached_dispatch_uses_a_distinct_target_command_family() {
        assert_eq!(
            dispatch_target_verb("dispatch_target_submit"),
            Some("submit")
        );
        assert_eq!(dispatch_target_verb("dispatch_submit"), None);
        assert_eq!(dispatch_target_verb("dispatch_target_unknown"), None);
    }

    /// The verb table must answer exactly the `dispatch_target_*` family the
    /// registry routes to the host control plane.
    #[test]
    fn dispatch_target_verbs_match_registry() {
        use openbitfun_product_domains::remote_surface::{operations, PeerStance};
        for op in operations() {
            let is_target = op.id.starts_with("dispatch_target_");
            assert_eq!(
                dispatch_target_verb(op.id).is_some(),
                is_target,
                "{} verb table disagrees with the registry",
                op.id
            );
            if is_target {
                assert_eq!(op.peer, PeerStance::HostControlPlane, "{}", op.id);
            }
        }
    }

    #[tokio::test]
    async fn cli_unsupported_commands_keep_the_legacy_prefix_and_add_a_reason() {
        let resp = handle_host_invoke("worktree_list", json!({})).await;
        match resp {
            RemoteResponse::HostInvokeResult {
                ok: false,
                error: Some(err),
                ..
            } => {
                assert!(
                    err.starts_with("command 'worktree_list' is not supported on CLI peer host"),
                    "{err}"
                );
                assert!(err.contains(": "), "reason must be appended: {err}");
            }
            other => panic!("unexpected response: {other:?}"),
        }
    }

    #[tokio::test]
    async fn browser_control_is_unsupported_not_local_only_on_cli() {
        let resp = handle_host_invoke("browser_control_launch", json!({})).await;
        match resp {
            RemoteResponse::HostInvokeResult {
                ok: false,
                error: Some(err),
                ..
            } => {
                assert!(err.contains("is not supported on CLI peer host"), "{err}");
                assert!(!err.contains("local-only"), "{err}");
            }
            other => panic!("unexpected response: {other:?}"),
        }
    }

    #[tokio::test]
    async fn unknown_command_reports_host_version_mismatch() {
        let resp = handle_host_invoke("not_an_openbitfun_command", json!({})).await;
        match resp {
            RemoteResponse::HostInvokeResult {
                ok: false,
                error: Some(err),
                ..
            } => {
                assert!(
                    err.contains("is unknown to this OpenBitFun CLI peer host version"),
                    "{err}"
                );
                assert!(!err.contains("is not supported on CLI peer host"), "{err}");
            }
            other => panic!("unexpected response: {other:?}"),
        }
    }

    /// `cancel_tool` and `get_all_tools_info` were previously unimplemented on
    /// the CLI peer host, so a controller rendering a CLI Peer session saw an
    /// ineffective Interrupt button and an empty tool list. They are now
    /// implemented in `commands::dialog::cancel_tool` and
    /// `commands::tools::get_all_tools_info`; this test pins that neither is
    /// refused by the local-only or CLI-unsupported gate before reaching the
    /// implemented handler. A future regression that removes the handler but
    /// leaves the command routable would land in the unsupported fallthrough
    /// branch, not here — that is caught by the capability advertisement +
    /// frontend gate instead.
    #[test]
    fn interactive_tools_and_tool_catalog_are_not_refused_before_dispatch() {
        for command in ["cancel_tool", "get_all_tools_info", "submit_user_answers"] {
            assert!(
                !is_local_only_command(command),
                "{command} must be routable to the peer host"
            );
            assert!(
                !is_cli_unsupported_command(command),
                "{command} must reach its implemented handler, not the unsupported gate"
            );
        }
    }

    /// The file explorer controller reads the workspace through the
    /// `explorer_*` aliases, while the editor reads metadata, sync hashes and
    /// watch state. These rows used to be refused as "no remote-workspace UI
    /// surface", which broke the file tree, the `@` reference picker and the
    /// editor breadcrumb in every CLI Peer session even though this host
    /// already served the same reads under the historical names.
    #[test]
    fn file_explorer_surface_is_not_refused_before_dispatch() {
        for command in [
            "explorer_get_children",
            "explorer_get_children_paginated",
            "explorer_get_file_tree",
            "get_file_tree",
            "get_file_metadata",
            "get_file_editor_sync_hash",
            "create_file",
            "start_file_watch",
            "stop_file_watch",
            "get_watched_paths",
        ] {
            assert!(
                !is_local_only_command(command),
                "{command} must be routable to the peer host"
            );
            assert!(
                !is_cli_unsupported_command(command),
                "{command} must reach its implemented handler, not the unsupported gate"
            );
        }
    }

    #[tokio::test]
    async fn attach_detach_only_updates_delivery_subscribers() {
        let _ = handle_host_invoke(
            "peer_control_attach",
            json!({ "controller_device_id": "ctrl-test-1" }),
        )
        .await;
        assert!(super::super::control::attached_controllers()
            .iter()
            .any(|id| id == "ctrl-test-1"));
        let _ = handle_host_invoke(
            "peer_control_detach",
            json!({ "controller_device_id": "ctrl-test-1" }),
        )
        .await;
        assert!(!super::super::control::attached_controllers()
            .iter()
            .any(|id| id == "ctrl-test-1"));
    }
}
