use openbitfun_core::external_sources::{
    external_source_read_only_snapshot, get_external_source_control_snapshot,
    ExternalSourceHostCapabilities, ExternalSourceOperationError, ExternalSourceOperationResult,
};
use std::path::PathBuf;

use crate::AppState;

// NOTE(Step 2a): these host-local external-source dispatch helpers were wired
// through the old `websocket.rs::handle_command` path. Under browser-direct
// ACP-over-WS the browser connects straight to the in-process app-server, so
// `external_sources` commands now hit the ACP `method_not_found` fallback
// (the desktop/Server Host external-source surface is temporarily unavailable
// in web mode -- tracked for a later batch that brings them onto the app-server
// schema). Kept here so the host capability plumbing stays intact for that
// follow-up; silenced as dead code in the meantime.

#[allow(dead_code)]
pub(crate) fn supports(method: &str) -> bool {
    matches!(
        method,
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
            | "choose_external_subagent_conflict_command"
            | "set_external_mcp_server_decision_command"
            | "set_external_mcp_servers_enabled_command"
            | "choose_external_mcp_conflict_command"
            | "update_external_integration_policy_command"
    )
}

#[allow(dead_code)]
pub(crate) async fn dispatch(
    method: &str,
    params: serde_json::Value,
    state: &AppState,
) -> ExternalSourceOperationResult<serde_json::Value> {
    if !matches!(
        method,
        "get_external_source_snapshot" | "get_external_source_control_snapshot"
    ) {
        return Err(ExternalSourceOperationError::host_capability_unavailable(
            if supports(method) {
                "This Server Host exposes external integrations as read-only. Use an authenticated Desktop or Peer Host to change them."
            } else {
                "Unknown external source operation"
            },
        ));
    }
    let request = params
        .get("request")
        .ok_or_else(|| ExternalSourceOperationError::invalid_request("missing request"))?;
    let workspace = external_workspace_id(state, request)?;
    let workspace = workspace.as_deref();
    match method {
        "get_external_source_snapshot" => {
            let force_refresh = optional_bool_field(request, "forceRefresh")?;
            let snapshot = external_source_read_only_snapshot(workspace, force_refresh)
                .await
                .map_err(
                    openbitfun_core::external_sources::sanitize_external_source_operation_error,
                )?;
            serde_json::to_value(snapshot.into_legacy_v0_compatible())
        }
        "get_external_source_control_snapshot" => {
            let force_refresh = optional_bool_field(request, "forceRefresh")?;
            let snapshot = get_external_source_control_snapshot(
                workspace,
                force_refresh,
                ExternalSourceHostCapabilities::read_only_projection(),
            )
            .await?;
            serde_json::to_value(snapshot)
        }
        _ => unreachable!("write and unknown methods are rejected before request parsing"),
    }
    .map_err(|_| {
        ExternalSourceOperationError::new(
            openbitfun_core::external_sources::ExternalSourceOperationErrorCode::Internal,
            "External source response could not be encoded",
            false,
        )
    })
}

/// Resolve the workspace an external-source request is scoped to.
///
/// `workspaceId` is authoritative and must name the workspace this Server
/// Host owns. `workspacePath` is accepted only as an upgrade path for pre-ID
/// callers: it is matched against the owned workspace root and then replaced
/// by the owned workspace ID, so paths never act as identity downstream.
#[allow(dead_code)]
fn external_workspace_id(
    state: &AppState,
    request: &serde_json::Value,
) -> ExternalSourceOperationResult<Option<String>> {
    let requested_id = match request.get("workspaceId") {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(id)) if !id.trim().is_empty() => Some(id.trim()),
        _ => {
            return Err(ExternalSourceOperationError::invalid_request(
                "workspaceId must be a non-empty string when provided",
            ))
        }
    };
    if let Some(requested_id) = requested_id {
        let owned = state.external_workspace_id.as_deref().ok_or_else(|| {
            ExternalSourceOperationError::new(
                openbitfun_core::external_sources::ExternalSourceOperationErrorCode::HostUnavailable,
                "The Server Host has no project workspace",
                false,
            )
        })?;
        if requested_id != owned {
            return Err(ExternalSourceOperationError::invalid_request(
                "External compatibility is limited to the Server Host workspace",
            ));
        }
        return Ok(Some(owned.to_string()));
    }

    let workspace = match request.get("workspacePath") {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(path)) if !path.trim().is_empty() => {
            Some(PathBuf::from(path))
        }
        _ => {
            return Err(ExternalSourceOperationError::invalid_request(
                "workspacePath must be a non-empty absolute path when provided",
            ))
        }
    };
    if workspace.as_ref().is_some_and(|path| !path.is_absolute()) {
        return Err(ExternalSourceOperationError::invalid_request(
            "External sources require an absolute workspace path",
        ));
    }
    let Some(requested) = workspace else {
        return Ok(None);
    };
    let (owned_id, owned_root) = state
        .external_workspace_id
        .as_deref()
        .zip(state.external_workspace_root.as_ref())
        .ok_or_else(|| {
            ExternalSourceOperationError::new(
                openbitfun_core::external_sources::ExternalSourceOperationErrorCode::HostUnavailable,
                "The Server Host has no project workspace",
                false,
            )
        })?;
    let requested = requested.canonicalize().map_err(|_| {
        ExternalSourceOperationError::invalid_request(
            "Workspace path is not available on this Host",
        )
    })?;
    if &requested != owned_root {
        return Err(ExternalSourceOperationError::invalid_request(
            "External compatibility is limited to the Server Host workspace",
        ));
    }
    Ok(Some(owned_id.to_string()))
}

#[allow(dead_code)]
fn optional_bool_field(
    request: &serde_json::Value,
    key: &str,
) -> ExternalSourceOperationResult<bool> {
    match request.get(key) {
        None | Some(serde_json::Value::Null) => Ok(false),
        Some(serde_json::Value::Bool(value)) => Ok(*value),
        _ => Err(ExternalSourceOperationError::invalid_request(format!(
            "'{key}' must be a boolean when provided"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app_state(external_workspace_root: Option<PathBuf>) -> AppState {
        AppState {
            external_workspace_id: external_workspace_root
                .as_ref()
                .map(|_| "server-workspace".to_string()),
            external_workspace_root,
            allowed_browser_origins: Default::default(),
            dispatch_host: None,
        }
    }

    #[test]
    fn only_external_source_methods_are_claimed() {
        assert!(supports("get_external_source_snapshot"));
        assert!(supports("get_external_source_control_snapshot"));
        assert!(supports("apply_external_source_control_action_command"));
        assert!(supports("set_external_mcp_servers_enabled_command"));
        assert!(supports("update_external_integration_policy_command"));
        assert!(!supports("open_workspace"));
    }

    #[test]
    fn workspace_paths_must_be_absolute() {
        let state = app_state(None);
        let request = serde_json::json!({ "workspacePath": "relative/project" });
        let error = external_workspace_id(&state, &request).unwrap_err();
        assert_eq!(error.code.as_str(), "invalid_request");
    }

    #[test]
    fn project_paths_require_an_owned_server_workspace() {
        let state = app_state(None);
        let workspace = std::env::current_dir().expect("current directory is available");
        let request = serde_json::json!({ "workspacePath": workspace });
        let error = external_workspace_id(&state, &request).unwrap_err();
        assert_eq!(error.code.as_str(), "host_unavailable");
    }

    #[test]
    fn project_paths_must_match_the_owned_server_workspace() {
        let workspace = std::env::current_dir()
            .expect("current directory is available")
            .canonicalize()
            .expect("current directory can be canonicalized");
        let state = app_state(Some(workspace.clone()));
        let request = serde_json::json!({ "workspacePath": workspace });
        assert_eq!(
            external_workspace_id(&state, &request).unwrap(),
            Some("server-workspace".to_string())
        );
    }

    #[test]
    fn workspace_ids_are_authoritative_and_must_match_the_owned_workspace() {
        let workspace = std::env::current_dir().expect("current directory is available");
        let state = app_state(Some(workspace));
        let request = serde_json::json!({ "workspaceId": "server-workspace" });
        assert_eq!(
            external_workspace_id(&state, &request).unwrap(),
            Some("server-workspace".to_string())
        );

        let request = serde_json::json!({
            "workspaceId": "other-workspace",
            "workspacePath": std::env::current_dir().expect("current directory is available"),
        });
        let error = external_workspace_id(&state, &request).unwrap_err();
        assert_eq!(error.code.as_str(), "invalid_request");

        let request = serde_json::json!({ "workspaceId": "" });
        let error = external_workspace_id(&state, &request).unwrap_err();
        assert_eq!(error.code.as_str(), "invalid_request");

        let state = app_state(None);
        let request = serde_json::json!({ "workspaceId": "server-workspace" });
        let error = external_workspace_id(&state, &request).unwrap_err();
        assert_eq!(error.code.as_str(), "host_unavailable");
    }

    #[test]
    fn malformed_optional_values_are_rejected() {
        let request = serde_json::json!({ "forceRefresh": "false" });
        let error = optional_bool_field(&request, "forceRefresh").unwrap_err();
        assert_eq!(error.code.as_str(), "invalid_request");

        let state = app_state(None);
        let request = serde_json::json!({ "workspacePath": false });
        let error = external_workspace_id(&state, &request).unwrap_err();
        assert_eq!(error.code.as_str(), "invalid_request");
    }

    #[tokio::test]
    async fn writes_are_rejected_before_request_or_workspace_parsing() {
        let state = app_state(None);
        let error = dispatch(
            "set_external_source_enabled_command",
            serde_json::json!({ "malformed": true }),
            &state,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code.as_str(), "host_capability_unavailable");

        let error = dispatch(
            "apply_external_source_control_action_command",
            serde_json::json!({ "malformed": true }),
            &state,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code.as_str(), "host_capability_unavailable");

        let error = dispatch(
            "reveal_external_source_location",
            serde_json::json!({ "malformed": true }),
            &state,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code.as_str(), "host_capability_unavailable");
    }
}
