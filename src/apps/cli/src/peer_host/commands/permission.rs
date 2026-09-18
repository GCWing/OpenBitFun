//! Permission HostInvoke handlers for CLI Peer Host.

use serde_json::{json, Value};

use openbitfun_agent_runtime::sdk::{PermissionGrantKey, PermissionReply};
use openbitfun_core::agentic::workspace::WorkspaceBinding;
use openbitfun_core::service::workspace::WorkspaceKind;

use crate::peer_host::args::{get_string, request_value};
use crate::peer_host::state::PeerHostState;

fn permission_reply(request: &Value) -> Result<PermissionReply, String> {
    let reply = get_string(request, "reply")?;
    if let Some(updated_input) = request.get("updatedInput").filter(|value| !value.is_null()) {
        if reply != "once" || !updated_input.is_object() {
            return Err("Edited input requires a one-time approval and an object".to_string());
        }
        return Ok(PermissionReply::OnceWithInput {
            updated_input: updated_input.clone(),
        });
    }
    match reply.as_str() {
        "once" => Ok(PermissionReply::Once),
        "always" => Ok(PermissionReply::Always),
        "reject" => Ok(PermissionReply::Reject {
            feedback: request
                .get("feedback")
                .and_then(Value::as_str)
                .map(str::to_string),
        }),
        value => Err(format!("Unsupported permission reply: {value}")),
    }
}

fn pagination_value(request: &Value, key: &str, default: usize) -> usize {
    request
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .unwrap_or(default)
}

async fn permission_project_id_for_workspace(
    state: &PeerHostState,
    workspace_id: &str,
) -> Result<String, String> {
    let workspace = state
        .workspace_service
        .get_workspace(workspace_id)
        .await
        .ok_or_else(|| format!("Workspace not found: {workspace_id}"))?;
    let is_remote = workspace.workspace_kind == WorkspaceKind::Remote;
    // The record already names the workspace; its persistence identity is a
    // projection of that record, never a path lookup.
    let binding = WorkspaceBinding::resolve(&workspace.id)
        .await
        .map_err(|error| format!("Workspace identity is unavailable: {workspace_id}: {error}"))?;
    openbitfun_core::agentic::tools::pipeline::permission_project_id_for_workspace_identity(
        &binding.session_identity,
        is_remote,
    )
    .map_err(|error| error.to_string())
}

pub(crate) fn list_pending_permission_requests(state: &PeerHostState) -> Result<Value, String> {
    let requests = state
        .agent_runtime
        .pending_permission_requests()
        .map_err(|error| error.into_message())?;
    serde_json::to_value(requests)
        .map_err(|error| format!("Failed to serialize permission requests: {error}"))
}

pub(crate) fn subscribe_permission_requests() -> Result<Value, String> {
    Ok(Value::Null)
}

pub(crate) async fn respond_permission(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let request_id = get_string(request, "requestId")?;
    // Any attached surface of the account may answer any pending request on
    // this host. The Runtime mailbox is the arbiter: it resolves exactly once,
    // so a request answered in this host's TUI is simply gone by the time a
    // second answer arrives, and `respond_permission` reports that itself.
    let reply = permission_reply(request)?;
    state
        .agent_runtime
        .respond_permission(&request_id, reply)
        .await
        .map_err(|error| error.into_message())?;
    Ok(Value::Null)
}

pub(crate) async fn respond_permission_batch(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let request_id = get_string(request, "requestId")?;
    let reply = permission_reply(request)?;
    let resolved_request_ids = state
        .agent_runtime
        .respond_permission_batch(&request_id, reply)
        .await
        .map_err(|error| error.into_message())?;
    serde_json::to_value(resolved_request_ids).map_err(|error| error.to_string())
}

pub(crate) async fn list_project_permission_grants(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let workspace_id = get_string(request, "workspaceId")?;
    let project_id = permission_project_id_for_workspace(state, &workspace_id).await?;
    let grants = state
        .agent_runtime
        .list_project_permission_grants(&project_id)
        .await
        .map_err(|error| error.into_message())?;
    serde_json::to_value(grants)
        .map_err(|error| format!("Failed to serialize permission grants: {error}"))
}

pub(crate) async fn remove_project_permission_grant(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let workspace_id = get_string(request, "workspaceId")?;
    let project_id = permission_project_id_for_workspace(state, &workspace_id).await?;
    let removed = state
        .agent_runtime
        .remove_project_permission_grant(PermissionGrantKey {
            project_id,
            action: get_string(request, "action")?,
            resource: get_string(request, "resource")?,
        })
        .await
        .map_err(|error| error.into_message())?;
    Ok(json!(removed))
}

pub(crate) async fn clear_project_permission_grants(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let workspace_id = get_string(request, "workspaceId")?;
    let project_id = permission_project_id_for_workspace(state, &workspace_id).await?;
    let removed = state
        .agent_runtime
        .clear_project_permission_grants(&project_id)
        .await
        .map_err(|error| error.into_message())?;
    Ok(json!(removed))
}

pub(crate) async fn list_project_permission_audit(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let workspace_id = get_string(request, "workspaceId")?;
    let project_id = permission_project_id_for_workspace(state, &workspace_id).await?;
    let mut records = state
        .agent_runtime
        .list_project_permission_audit(&project_id)
        .await
        .map_err(|error| error.into_message())?;
    records.sort_by(|left, right| {
        right
            .timestamp_ms
            .cmp(&left.timestamp_ms)
            .then_with(|| right.audit_id.cmp(&left.audit_id))
    });
    let page = pagination_value(request, "page", 0);
    let page_size = pagination_value(request, "pageSize", 50).clamp(1, 100);
    let total = records.len();
    let offset = page.saturating_mul(page_size).min(total);
    let records = records
        .into_iter()
        .skip(offset)
        .take(page_size)
        .collect::<Vec<_>>();
    Ok(json!({
        "projectId": project_id,
        "records": records,
        "page": page,
        "pageSize": page_size,
        "total": total,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_reply_rejects_unknown_values() {
        let error = permission_reply(&json!({ "reply": "later" })).unwrap_err();
        assert_eq!(error, "Unsupported permission reply: later");
    }

    #[test]
    fn permission_reply_preserves_rejection_feedback() {
        assert_eq!(
            permission_reply(&json!({ "reply": "reject", "feedback": "not now" })).unwrap(),
            PermissionReply::Reject {
                feedback: Some("not now".to_string()),
            }
        );
    }

    #[test]
    fn permission_audit_page_size_is_bounded() {
        assert_eq!(
            pagination_value(&json!({}), "pageSize", 50).clamp(1, 100),
            50
        );
        assert_eq!(
            pagination_value(&json!({ "pageSize": 0 }), "pageSize", 50).clamp(1, 100),
            1
        );
        assert_eq!(
            pagination_value(&json!({ "pageSize": 500 }), "pageSize", 50).clamp(1, 100),
            100
        );
    }
}

/// Preserve Desktop's distinct persisted-session and exact-active-turn selectors.
pub(crate) async fn session_permission_mode(
    state: &PeerHostState,
    args: &Value,
    mutate: bool,
    active_turn_only: bool,
) -> Result<Value, String> {
    use crate::peer_host::args::{get_string, optional_string};
    use openbitfun_core::agentic::core::SessionState;

    let request = request_value(args);
    let session_id = get_string(request, "sessionId")?;
    let session_id = session_id.trim();
    if session_id.is_empty() {
        return Err("session_id is required".into());
    }
    let mode = parse_selector_mode(request)?;
    let turn_id = optional_string(request, "turnId");
    if active_turn_only && turn_id.is_none() {
        return Err("turn_id is required".into());
    }
    if optional_string(request, "workspaceId").is_some()
        || optional_string(request, "workspacePath").is_some()
    {
        super::session::ensure_coordinator_session(state, args).await?;
    }
    let manager = &state.compatibility;
    let session = manager
        .loaded_session_snapshot(session_id)
        .map_err(|error| error.to_string())?
        .ok_or("Session is not loaded")?;
    let active_turn_id = turn_id.filter(|turn_id| matches!(
        &session.state, SessionState::Processing { current_turn_id, .. } if current_turn_id == turn_id
    ));
    if mutate {
        if active_turn_only {
            let turn_id = active_turn_id
                .as_deref()
                .ok_or("Turn is no longer active for this session")?;
            match mode {
                Some(mode) => {
                    if !manager.set_active_turn_permission_mode(session_id, turn_id, mode) {
                        return Err("Turn is no longer active for this session".into());
                    }
                }
                None => {
                    manager.clear_active_turn_permission_mode(session_id, turn_id);
                }
            }
        } else {
            manager
                .update_session_permission_mode(session_id, mode)
                .await
                .map_err(|e| e.to_string())?;
            if let Some(turn_id) = optional_string(request, "turnId") {
                manager.clear_active_turn_permission_mode(session_id, &turn_id);
            }
        }
    }
    Ok(serde_json::json!({
        "mode": manager.session_permission_mode(session_id),
        "turnMode": active_turn_id.as_deref().and_then(|turn| manager.active_turn_permission_mode(session_id, turn)),
        "activeTurnId": active_turn_id,
    }))
}

fn parse_selector_mode(
    request: &Value,
) -> Result<Option<openbitfun_runtime_ports::PermissionMode>, String> {
    use openbitfun_runtime_ports::PermissionMode;
    match request.get("mode") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if value.trim().is_empty() => Ok(None),
        Some(Value::String(value)) => Ok(Some(
            PermissionMode::parse(value.trim())
                .ok_or_else(|| format!("unsupported permission mode: {value}"))?,
        )),
        _ => return Err("Invalid permission mode".into()),
    }
}

#[cfg(test)]
mod selector_tests {
    use super::*;
    use openbitfun_runtime_ports::PermissionMode;

    #[test]
    fn legacy_and_current_selectors_preserve_clear_and_explicit_modes() {
        for request in [
            serde_json::json!({}),
            serde_json::json!({"mode": null}),
            serde_json::json!({"mode": " "}),
        ] {
            assert_eq!(parse_selector_mode(&request).unwrap(), None);
        }
        assert_eq!(
            parse_selector_mode(&serde_json::json!({"mode": "full_access"})).unwrap(),
            Some(PermissionMode::FullAccess)
        );
        assert_eq!(
            parse_selector_mode(&serde_json::json!({"mode": "ask"})).unwrap(),
            Some(PermissionMode::Ask)
        );
        for value in [
            serde_json::json!("unknown-future-mode"),
            serde_json::json!(false),
            serde_json::json!({}),
        ] {
            assert!(parse_selector_mode(&serde_json::json!({"mode": value})).is_err());
        }
    }
}

/// Small live mailbox for reconnecting controllers; never reads transcript history.
pub(crate) fn get_session_interaction_mailbox(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let session_id = get_string(request_value(args), "sessionId")?;
    serde_json::to_value(
        state
            .agent_runtime
            .session_interaction_snapshot(&session_id),
    )
    .map_err(|error| error.to_string())
}
