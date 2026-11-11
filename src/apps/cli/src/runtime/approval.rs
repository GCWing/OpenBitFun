use openbitfun_agent_runtime::permission::{
    PERMISSION_APPROVAL_STRATEGY_CONTEXT_KEY, PERMISSION_MODE_CONTEXT_KEY,
};
use openbitfun_agent_runtime::sdk::{PermissionRequest, AUTO_APPROVE_ASK_CONTEXT_KEY};
use openbitfun_agent_runtime::user_questions::USER_INPUT_AVAILABLE_CONTEXT_KEY;
use openbitfun_runtime_ports::PermissionMode;
use serde_json::{Map, Value};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CliApprovalPolicy {
    /// Inherit the persisted user interaction preference.
    Ask,
    /// Explicitly disable Auto mode for this invocation/session.
    DisableAuto,
    Reject,
    /// Automatic approval for an interactive session: classify asks with the
    /// configured approval provider and fall back to the user mailbox.
    Auto,
    /// Explicit one-shot bypass used by `exec --auto` and detached auto jobs.
    ImmediateAllow,
    /// Use the configured approval model for this headless invocation.
    Model,
}

/// Build invocation-scoped approval metadata consumed by the shared Runtime.
///
/// Headless entrypoints must use this helper instead of mutating persisted
/// confirmation settings or defining a parallel permission mechanism.
pub(crate) fn approval_metadata(approval_policy: CliApprovalPolicy) -> Map<String, Value> {
    let mut metadata = Map::new();
    if matches!(
        approval_policy,
        CliApprovalPolicy::Reject | CliApprovalPolicy::ImmediateAllow | CliApprovalPolicy::Model
    ) {
        metadata.insert(
            USER_INPUT_AVAILABLE_CONTEXT_KEY.to_string(),
            Value::Bool(false),
        );
    }
    let auto_approve_ask = match approval_policy {
        CliApprovalPolicy::Ask => None,
        CliApprovalPolicy::DisableAuto | CliApprovalPolicy::Reject => Some(false),
        CliApprovalPolicy::Auto | CliApprovalPolicy::Model => Some(false),
        CliApprovalPolicy::ImmediateAllow => Some(true),
    };
    if let Some(auto_approve_ask) = auto_approve_ask {
        metadata.insert(
            AUTO_APPROVE_ASK_CONTEXT_KEY.to_string(),
            Value::Bool(auto_approve_ask),
        );
        // Carry the whole mode as well, so this invocation resolves through the
        // same single value as every other surface. `Ask` stays absent: it means
        // "inherit the persisted preference", not "force the ask mode".
        let mode = if matches!(
            approval_policy,
            CliApprovalPolicy::Auto | CliApprovalPolicy::ImmediateAllow
        ) {
            PermissionMode::AutoApprove
        } else {
            PermissionMode::Ask
        };
        metadata.insert(
            PERMISSION_MODE_CONTEXT_KEY.to_string(),
            Value::String(mode.as_str().to_string()),
        );
    }
    let strategy = match approval_policy {
        CliApprovalPolicy::Auto | CliApprovalPolicy::Model => Some("model"),
        CliApprovalPolicy::DisableAuto | CliApprovalPolicy::Reject => Some("interactive"),
        CliApprovalPolicy::ImmediateAllow => Some("immediate_allow"),
        CliApprovalPolicy::Ask => None,
    };
    if let Some(strategy) = strategy {
        metadata.insert(
            PERMISSION_APPROVAL_STRATEGY_CONTEXT_KEY.to_string(),
            Value::String(strategy.to_string()),
        );
    }
    metadata
}

pub(crate) fn permission_request_targets_session(
    request: &PermissionRequest,
    session_id: &str,
) -> bool {
    request.session_id == session_id
        || request
            .delegation
            .as_ref()
            .is_some_and(|delegation| delegation.parent_session_id == session_id)
}

#[cfg(test)]
mod tests {
    use super::{approval_metadata, permission_request_targets_session, CliApprovalPolicy};
    use openbitfun_agent_runtime::permission::{
        PERMISSION_APPROVAL_STRATEGY_CONTEXT_KEY, PERMISSION_MODE_CONTEXT_KEY,
    };
    use openbitfun_agent_runtime::sdk::{
        PermissionDelegationContext, PermissionRequest, PermissionRequestSource,
        PermissionRequestSourceKind, AUTO_APPROVE_ASK_CONTEXT_KEY,
    };
    use openbitfun_agent_runtime::user_questions::USER_INPUT_AVAILABLE_CONTEXT_KEY;
    use serde_json::Map;

    fn request() -> PermissionRequest {
        PermissionRequest {
            request_id: "request-1".to_string(),
            round_id: "synthetic:request-1".to_string(),
            order: 0,
            tool_call_id: Some("child-tool".to_string()),
            project_path: None,
            project_id: "project-1".to_string(),
            session_id: "child-session".to_string(),
            agent_id: "Explore".to_string(),
            action: "edit".to_string(),
            resources: vec!["src/main.rs".to_string()],
            save_resources: Vec::new(),
            source: PermissionRequestSource {
                kind: PermissionRequestSourceKind::ToolCall,
                identity: "Write".to_string(),
            },
            delegation: Some(PermissionDelegationContext {
                parent_session_id: "parent-session".to_string(),
                parent_dialog_turn_id: Some("parent-turn".to_string()),
                parent_tool_call_id: "parent-task".to_string(),
                subagent_type: "Explore".to_string(),
            }),
            display_metadata: Map::new(),
        }
    }

    #[test]
    fn permission_requests_target_their_execution_and_parent_interaction_sessions() {
        let request = request();

        assert!(permission_request_targets_session(
            &request,
            "child-session"
        ));
        assert!(permission_request_targets_session(
            &request,
            "parent-session"
        ));
        assert!(!permission_request_targets_session(
            &request,
            "unrelated-session"
        ));
    }

    #[test]
    fn headless_approval_metadata_is_invocation_scoped() {
        let auto = approval_metadata(CliApprovalPolicy::ImmediateAllow);
        assert_eq!(
            auto.get(USER_INPUT_AVAILABLE_CONTEXT_KEY),
            Some(&serde_json::Value::Bool(false))
        );
        assert_eq!(
            auto.get(AUTO_APPROVE_ASK_CONTEXT_KEY),
            Some(&serde_json::Value::Bool(true))
        );

        let reject = approval_metadata(CliApprovalPolicy::Reject);
        assert_eq!(
            reject.get(USER_INPUT_AVAILABLE_CONTEXT_KEY),
            Some(&serde_json::Value::Bool(false))
        );
        assert_eq!(
            reject.get(AUTO_APPROVE_ASK_CONTEXT_KEY),
            Some(&serde_json::Value::Bool(false))
        );

        assert!(approval_metadata(CliApprovalPolicy::Ask).is_empty());
        assert_eq!(
            approval_metadata(CliApprovalPolicy::DisableAuto).get(AUTO_APPROVE_ASK_CONTEXT_KEY),
            Some(&serde_json::Value::Bool(false))
        );
    }

    #[test]
    fn headless_approval_metadata_carries_the_resolved_permission_mode() {
        assert_eq!(
            approval_metadata(CliApprovalPolicy::Auto).get(PERMISSION_MODE_CONTEXT_KEY),
            Some(&serde_json::Value::String("auto_approve".to_string()))
        );
        assert_eq!(
            approval_metadata(CliApprovalPolicy::Auto)
                .get(PERMISSION_APPROVAL_STRATEGY_CONTEXT_KEY),
            Some(&serde_json::Value::String("model".to_string()))
        );
        assert_eq!(
            approval_metadata(CliApprovalPolicy::ImmediateAllow)
                .get(PERMISSION_APPROVAL_STRATEGY_CONTEXT_KEY),
            Some(&serde_json::Value::String("immediate_allow".to_string()))
        );
        for policy in [CliApprovalPolicy::DisableAuto, CliApprovalPolicy::Reject] {
            assert_eq!(
                approval_metadata(policy).get(PERMISSION_MODE_CONTEXT_KEY),
                Some(&serde_json::Value::String("ask".to_string()))
            );
        }

        // Inheriting the persisted preference must stay absent, so it does not
        // pin the turn to the ask mode.
        assert_eq!(
            approval_metadata(CliApprovalPolicy::Ask).get(PERMISSION_MODE_CONTEXT_KEY),
            None
        );
    }

    #[test]
    fn model_approval_is_distinct_from_immediate_allow() {
        let metadata = approval_metadata(CliApprovalPolicy::Model);
        assert_eq!(
            metadata.get(PERMISSION_APPROVAL_STRATEGY_CONTEXT_KEY),
            Some(&serde_json::Value::String("model".to_string()))
        );
        assert_eq!(
            metadata.get(AUTO_APPROVE_ASK_CONTEXT_KEY),
            Some(&serde_json::Value::Bool(false))
        );
        assert_eq!(
            metadata.get(USER_INPUT_AVAILABLE_CONTEXT_KEY),
            Some(&serde_json::Value::Bool(false))
        );
    }
}
