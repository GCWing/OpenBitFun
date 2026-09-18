//! External compatibility HostInvoke handlers for CLI Peer Host.

use openbitfun_core::external_sources::{
    apply_external_source_control_action, choose_external_mcp_conflict,
    choose_external_subagent_conflict, external_source_discovery_snapshot,
    external_source_snapshot, get_external_source_control_snapshot,
    set_external_mcp_server_decision, set_external_mcp_servers_enabled,
    set_external_prompt_command_conflict_choice, set_external_source_enabled,
    set_external_subagent_activation, set_external_subagent_model_binding,
    set_external_subagents_enabled, set_external_tool_conflict_choice,
    set_external_tool_target_decision, set_external_tool_targets_enabled,
    update_external_integration_policy, ExternalIntegrationPolicyMutation,
    ExternalSourceControlRequestV1, ExternalSourceHostCapabilities, ExternalSourceOperationError,
    ExternalSourceOperationErrorCode, ExternalSourceOperationResult, ExternalSourcePublicSnapshot,
    ExternalSubagentModelBindingTarget,
};
use serde_json::Value;

use crate::peer_host::args::request_value;
use crate::peer_host::state::PeerHostState;

fn required_bool(request: &Value, key: &str) -> ExternalSourceOperationResult<bool> {
    optional_bool_field(request, key)?.ok_or_else(|| {
        ExternalSourceOperationError::invalid_request(format!("Missing or invalid '{key}'"))
    })
}

fn required_string(request: &Value, key: &str) -> ExternalSourceOperationResult<String> {
    optional_string_field(request, key)?.ok_or_else(|| {
        ExternalSourceOperationError::invalid_request(format!("Missing or invalid '{key}'"))
    })
}

fn optional_bool_field(request: &Value, key: &str) -> ExternalSourceOperationResult<Option<bool>> {
    match request.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        _ => Err(ExternalSourceOperationError::invalid_request(format!(
            "'{key}' must be a boolean when provided"
        ))),
    }
}

fn optional_string_field(
    request: &Value,
    key: &str,
) -> ExternalSourceOperationResult<Option<String>> {
    match request.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if !value.trim().is_empty() => Ok(Some(value.clone())),
        _ => Err(ExternalSourceOperationError::invalid_request(format!(
            "'{key}' must be a non-empty string when provided"
        ))),
    }
}

fn required_u64(request: &Value, key: &str) -> ExternalSourceOperationResult<u64> {
    request.get(key).and_then(Value::as_u64).ok_or_else(|| {
        ExternalSourceOperationError::invalid_request(format!("Missing or invalid '{key}'"))
    })
}

fn decision_pairs(
    request: &Value,
    first_key: &str,
    second_key: &str,
) -> ExternalSourceOperationResult<Vec<(String, String)>> {
    let decisions = request
        .get("decisions")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            ExternalSourceOperationError::invalid_request("Missing or invalid 'decisions'")
        })?;
    decisions
        .iter()
        .map(|decision| {
            Ok((
                required_string(decision, first_key)?,
                required_string(decision, second_key)?,
            ))
        })
        .collect()
}

fn model_binding_target_field(
    request: &Value,
    key: &str,
) -> ExternalSourceOperationResult<Option<ExternalSubagentModelBindingTarget>> {
    match request.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => serde_json::from_value(value.clone())
            .map(Some)
            .map_err(|_| {
                ExternalSourceOperationError::invalid_request(format!(
                    "'{key}' must be a valid external subagent model binding target"
                ))
            }),
    }
}

pub(super) async fn workspace_id(
    state: &PeerHostState,
    request: &Value,
) -> ExternalSourceOperationResult<Option<String>> {
    let id = optional_string_field(request, "workspaceId")?;
    let legacy = optional_string_field(request, "workspacePath")?;
    if id.is_none() && legacy.is_none() {
        return Ok(None);
    }
    let workspace = state
        .workspace_service
        .resolve_legacy_workspace_reference(
            id.as_deref(),
            legacy.as_deref().unwrap_or_default(),
            None,
            None,
        )
        .await
        .map_err(|error| ExternalSourceOperationError::invalid_request(error.to_string()))?
        .ok_or_else(|| {
            ExternalSourceOperationError::invalid_request("Unknown workspace reference")
        })?;
    if workspace.workspace_kind == openbitfun_core::service::workspace::WorkspaceKind::Remote {
        return Err(ExternalSourceOperationError::host_capability_unavailable(
            "External sources do not support remote workspaces",
        ));
    }
    Ok(Some(workspace.id))
}

fn public_snapshot(
    snapshot: openbitfun_core::external_sources::ExternalSourceCatalogSnapshot,
) -> ExternalSourceOperationResult<Value> {
    serde_json::to_value(ExternalSourcePublicSnapshot::from(snapshot).into_legacy_v0_compatible())
        .map_err(|_| {
            ExternalSourceOperationError::new(
                ExternalSourceOperationErrorCode::Internal,
                "External source response could not be encoded",
                false,
            )
        })
}

pub(crate) async fn dispatch(
    command: &str,
    args: &Value,
    state: &PeerHostState,
) -> Result<Value, String> {
    dispatch_inner(command, args, state)
        .await
        .map_err(|error| error.encode())
}

async fn dispatch_inner(
    command: &str,
    args: &Value,
    state: &PeerHostState,
) -> ExternalSourceOperationResult<Value> {
    if command == "reveal_external_source_location" {
        return Err(ExternalSourceOperationError::host_capability_unavailable(
            "This Peer Host cannot reveal source locations in its file manager",
        ));
    }
    let request = request_value(args);
    let workspace = workspace_id(state, request).await?;
    let workspace = workspace.as_deref();
    if command == "get_external_source_discovery_snapshot" {
        let snapshot = external_source_discovery_snapshot(
            workspace,
            optional_bool_field(request, "forceRefresh")?.unwrap_or(false),
            ExternalSourceHostCapabilities::read_write(),
        )
        .await
        .map_err(openbitfun_core::external_sources::sanitize_external_source_operation_error)?;
        return serde_json::to_value(snapshot).map_err(|_| {
            ExternalSourceOperationError::new(
                ExternalSourceOperationErrorCode::Internal,
                "External discovery response could not be encoded",
                false,
            )
        });
    }
    if command == "get_external_source_control_snapshot" {
        let snapshot = get_external_source_control_snapshot(
            workspace,
            optional_bool_field(request, "forceRefresh")?.unwrap_or(false),
            ExternalSourceHostCapabilities::read_write(),
        )
        .await?;
        return serde_json::to_value(snapshot).map_err(|_| {
            ExternalSourceOperationError::new(
                ExternalSourceOperationErrorCode::Internal,
                "External source control response could not be encoded",
                false,
            )
        });
    }
    if command == "apply_external_source_control_action_command" {
        let control = request.get("control").ok_or_else(|| {
            ExternalSourceOperationError::invalid_request("Missing control request")
        })?;
        let snapshot =
            apply_external_source_control_action(workspace, control_request(control)?).await?;
        return serde_json::to_value(snapshot).map_err(|_| {
            ExternalSourceOperationError::new(
                ExternalSourceOperationErrorCode::Internal,
                "External source control response could not be encoded",
                false,
            )
        });
    }
    let snapshot = match command {
        "get_external_source_snapshot" => {
            external_source_snapshot(
                workspace,
                optional_bool_field(request, "forceRefresh")?.unwrap_or(false),
            )
            .await
        }
        "set_external_source_enabled_command" => {
            set_external_source_enabled(
                workspace,
                &required_string(request, "sourceKey")?,
                required_bool(request, "enabled")?,
                required_u64(request, "expectedPreferenceRevision")?,
            )
            .await
        }
        "set_external_source_conflict_choice_command" => {
            set_external_prompt_command_conflict_choice(
                workspace,
                &required_string(request, "conflictKey")?,
                &required_string(request, "candidateId")?,
                required_u64(request, "expectedPreferenceRevision")?,
            )
            .await
        }
        "set_external_tool_target_decision_command" => {
            set_external_tool_target_decision(
                workspace,
                &required_string(request, "approvalKey")?,
                &required_string(request, "decisionKey")?,
                required_bool(request, "approved")?,
                required_u64(request, "expectedPreferenceRevision")?,
            )
            .await
        }
        "set_external_tool_targets_enabled_command" => {
            set_external_tool_targets_enabled(
                workspace,
                decision_pairs(request, "approvalKey", "decisionKey")?,
                required_bool(request, "enabled")?,
                required_u64(request, "expectedCatalogGeneration")?,
                required_u64(request, "expectedPreferenceRevision")?,
            )
            .await
        }
        "set_external_tool_conflict_choice_command" => {
            set_external_tool_conflict_choice(
                workspace,
                &required_string(request, "conflictKey")?,
                &required_string(request, "candidateId")?,
                required_u64(request, "expectedPreferenceRevision")?,
            )
            .await
        }
        "set_external_subagent_activation_command" => {
            set_external_subagent_activation(
                workspace,
                &required_string(request, "candidateId")?,
                required_bool(request, "approved")?,
                required_u64(request, "expectedSubagentGeneration")?,
                required_u64(request, "expectedPreferenceRevision")?,
                &required_string(request, "decisionKey")?,
            )
            .await
        }
        "set_external_subagents_enabled_command" => {
            set_external_subagents_enabled(
                workspace,
                decision_pairs(request, "candidateId", "decisionKey")?,
                required_bool(request, "enabled")?,
                required_u64(request, "expectedSubagentGeneration")?,
                required_u64(request, "expectedPreferenceRevision")?,
            )
            .await
        }
        "set_external_subagent_model_binding_command" => {
            set_external_subagent_model_binding(
                workspace,
                &required_string(request, "bindingKey")?,
                model_binding_target_field(request, "target")?,
                required_u64(request, "expectedSubagentGeneration")?,
                required_u64(request, "expectedPreferenceRevision")?,
            )
            .await
        }
        "choose_external_subagent_conflict_command" => {
            choose_external_subagent_conflict(
                workspace,
                &required_string(request, "conflictKey")?,
                &required_string(request, "candidateId")?,
                optional_bool_field(request, "approveExternal")?.unwrap_or(false),
                required_u64(request, "expectedSubagentGeneration")?,
                required_u64(request, "expectedPreferenceRevision")?,
            )
            .await
        }
        "set_external_mcp_server_decision_command" => {
            set_external_mcp_server_decision(
                workspace,
                &required_string(request, "candidateId")?,
                &required_string(request, "decisionKey")?,
                required_bool(request, "approved")?,
                required_u64(request, "expectedMcpGeneration")?,
                required_u64(request, "expectedPreferenceRevision")?,
            )
            .await
        }
        "set_external_mcp_servers_enabled_command" => {
            set_external_mcp_servers_enabled(
                workspace,
                decision_pairs(request, "candidateId", "decisionKey")?,
                required_bool(request, "enabled")?,
                required_u64(request, "expectedMcpGeneration")?,
                required_u64(request, "expectedPreferenceRevision")?,
            )
            .await
        }
        "choose_external_mcp_conflict_command" => {
            choose_external_mcp_conflict(
                workspace,
                &required_string(request, "conflictKey")?,
                &required_string(request, "candidateId")?,
                optional_bool_field(request, "approveExternal")?.unwrap_or(false),
                required_u64(request, "expectedMcpGeneration")?,
                required_u64(request, "expectedPreferenceRevision")?,
            )
            .await
        }
        "update_external_integration_policy_command" => {
            let mutation = request
                .get("mutation")
                .cloned()
                .ok_or_else(|| ExternalSourceOperationError::invalid_request("Missing mutation"))?;
            let mutation: ExternalIntegrationPolicyMutation = serde_json::from_value(mutation)
                .map_err(|_| {
                    ExternalSourceOperationError::invalid_request("Invalid policy mutation")
                })?;
            update_external_integration_policy(workspace, mutation).await
        }
        _ => {
            return Err(ExternalSourceOperationError::host_capability_unavailable(
                format!("External compatibility command '{command}' is not supported"),
            ))
        }
    }
    .map_err(openbitfun_core::external_sources::sanitize_external_source_operation_error)?;

    public_snapshot(snapshot)
}

fn control_request(
    request: &Value,
) -> ExternalSourceOperationResult<ExternalSourceControlRequestV1> {
    serde_json::from_value(request.clone()).map_err(|_| {
        ExternalSourceOperationError::invalid_request("Invalid external source control request")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use openbitfun_core::external_sources::ExternalSourceControlActionV1;

    #[test]
    fn optional_host_fields_reject_wrong_types() {
        let request = serde_json::json!({
            "workspacePath": false,
            "forceRefresh": "false"
        });
        assert_eq!(
            optional_string_field(&request, "workspacePath")
                .unwrap_err()
                .code,
            ExternalSourceOperationErrorCode::InvalidRequest
        );
        assert_eq!(
            optional_bool_field(&request, "forceRefresh")
                .unwrap_err()
                .code,
            ExternalSourceOperationErrorCode::InvalidRequest
        );
    }

    #[test]
    fn peer_errors_use_the_shared_typed_envelope() {
        let encoded = ExternalSourceOperationError::new(
            ExternalSourceOperationErrorCode::StaleRevision,
            "Refresh before retrying",
            true,
        )
        .encode();
        let value: Value = serde_json::from_str(&encoded).unwrap();
        assert_eq!(value["code"], "stale_revision");
        assert_eq!(value["retryable"], true);
    }

    #[test]
    fn peer_host_does_not_advertise_desktop_local_reveal_actions() {
        assert!(!ExternalSourceHostCapabilities::read_write().can_reveal_source_location);
    }

    #[test]
    fn peer_control_request_deserializes_the_shared_action() {
        let request = serde_json::json!({
            "schemaVersion": 1,
            "operationId": "peer-safe-mode",
            "expectedPreferenceRevision": 3,
            "action": { "type": "set_safe_mode", "enabled": true }
        });

        let control = control_request(&request).unwrap();

        assert!(matches!(
            control.action,
            ExternalSourceControlActionV1::SetSafeMode { enabled: true }
        ));
    }

    #[test]
    fn peer_model_binding_target_parser_accepts_set_and_clear_shapes() {
        let set = serde_json::json!({
            "target": { "kind": "primary" }
        });
        assert_eq!(
            model_binding_target_field(&set, "target").unwrap(),
            Some(ExternalSubagentModelBindingTarget::Primary)
        );

        let clear = serde_json::json!({ "target": null });
        assert_eq!(model_binding_target_field(&clear, "target").unwrap(), None);

        let invalid = serde_json::json!({ "target": { "kind": "automatic" } });
        assert_eq!(
            model_binding_target_field(&invalid, "target")
                .unwrap_err()
                .code,
            ExternalSourceOperationErrorCode::InvalidRequest
        );
    }

    #[test]
    fn peer_bulk_decisions_preserve_the_reviewed_identity_pairs() {
        let request = serde_json::json!({
            "decisions": [
                { "candidateId": "agent-a", "decisionKey": "decision-a" },
                { "candidateId": "agent-b", "decisionKey": "decision-b" }
            ]
        });

        assert_eq!(
            decision_pairs(&request, "candidateId", "decisionKey").unwrap(),
            vec![
                ("agent-a".to_string(), "decision-a".to_string()),
                ("agent-b".to_string(), "decision-b".to_string()),
            ]
        );
    }
}
