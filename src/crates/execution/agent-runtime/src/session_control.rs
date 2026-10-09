//! Portable SessionControl tool decisions.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SessionControlAction {
    Create,
    Cancel,
    Delete,
    List,
    Rename,
}

impl SessionControlAction {
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Create => "create",
            Self::Cancel => "cancel",
            Self::Delete => "delete",
            Self::List => "list",
            Self::Rename => "rename",
        }
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub enum SessionControlAgentType {
    #[serde(rename = "Standard", alias = "Standard", alias = "AGENTIC")]
    Agentic,
    #[serde(rename = "Cowork", alias = "cowork", alias = "COWORK")]
    Cowork,
    #[serde(
        rename = "DeepResearch",
        alias = "deepresearch",
        alias = "DEEPRESEARCH"
    )]
    DeepResearch,
}

impl SessionControlAgentType {
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Agentic => "Standard",
            Self::Cowork => "Cowork",
            Self::DeepResearch => "DeepResearch",
        }
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct SessionControlInput {
    pub action: SessionControlAction,
    pub workspace: Option<String>,
    pub session_id: Option<String>,
    pub session_name: Option<String>,
    pub agent_type: Option<SessionControlAgentType>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SessionControlValidationContext<'a> {
    pub current_session_id: Option<&'a str>,
    pub has_workspace_root: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionControlValidationResult {
    pub result: bool,
    pub message: Option<String>,
    pub error_code: Option<i32>,
    pub meta: Option<Value>,
}

impl Default for SessionControlValidationResult {
    fn default() -> Self {
        Self {
            result: true,
            message: None,
            error_code: None,
            meta: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionControlCancelRoute {
    RequesterViaScheduler { requester_session_id: String },
    CoordinatorDirect,
}

pub fn resolve_session_control_cancel_route(
    requester_session_id: Option<&str>,
    scheduler_available: bool,
) -> SessionControlCancelRoute {
    match (requester_session_id, scheduler_available) {
        (Some(requester_session_id), true) => SessionControlCancelRoute::RequesterViaScheduler {
            requester_session_id: requester_session_id.to_string(),
        },
        _ => SessionControlCancelRoute::CoordinatorDirect,
    }
}

fn invalid(message: impl Into<String>) -> SessionControlValidationResult {
    SessionControlValidationResult {
        result: false,
        message: Some(message.into()),
        error_code: Some(400),
        meta: None,
    }
}

pub fn validate_session_id(session_id: &str) -> Result<(), String> {
    openbitfun_core_types::validate_session_id(session_id)
}

pub fn default_session_name() -> &'static str {
    "New Session"
}

pub fn session_control_session_name_or_default(session_name: Option<&str>) -> String {
    session_name
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(default_session_name())
        .to_string()
}

pub fn session_control_agent_type_or_default(
    agent_type: Option<&SessionControlAgentType>,
) -> String {
    agent_type
        .map(|agent_type| agent_type.as_str().to_string())
        .unwrap_or_else(|| "Standard".to_string())
}

pub fn session_control_creator_marker(creator_session_id: &str) -> String {
    format!("session-{creator_session_id}")
}

fn validate_workspace_shape(workspace: &str) -> SessionControlValidationResult {
    if workspace.trim().is_empty() {
        return invalid("workspace is required and cannot be empty");
    }

    // IDs are opaque. The host resolves a registered ID first, then validates
    // an unmatched operand as an absolute path in the caller's environment.
    SessionControlValidationResult::default()
}

fn validate_mutating_action_target(
    action: &SessionControlAction,
    input: &SessionControlInput,
    context: SessionControlValidationContext<'_>,
) -> SessionControlValidationResult {
    if input.agent_type.is_some() {
        return invalid("agent_type is only allowed for create");
    }
    // `rename` carries the new session title via session_name; every other
    // mutating action rejects it (only `create` otherwise accepts session_name).
    if input.session_name.is_some() && !matches!(action, SessionControlAction::Rename) {
        return invalid("session_name is only allowed for create");
    }
    // `rename` requires a non-empty new title.
    if matches!(action, SessionControlAction::Rename) {
        let Some(session_name) = input.session_name.as_deref() else {
            return invalid("session_name is required for rename");
        };
        if session_name.trim().is_empty() {
            return invalid("session_name must not be empty for rename");
        }
    }

    let Some(session_id) = input.session_id.as_deref() else {
        return invalid(format!("session_id is required for {}", action.as_str()));
    };
    if let Err(message) = validate_session_id(session_id) {
        return invalid(message);
    }

    if context.current_session_id == Some(session_id) && context.has_workspace_root {
        return invalid(format!(
            "cannot {} the current session from SessionControl",
            action.as_str()
        ));
    }

    SessionControlValidationResult::default()
}

pub fn validate_session_control_input(
    input: &SessionControlInput,
    context: SessionControlValidationContext<'_>,
) -> SessionControlValidationResult {
    if let Some(workspace) = input.workspace.as_deref() {
        let should_validate_workspace = matches!(
            input.action,
            SessionControlAction::Create | SessionControlAction::List
        );
        if !should_validate_workspace {
            return validate_mutating_action_target(&input.action, input, context);
        }

        let workspace_validation = validate_workspace_shape(workspace);
        if !workspace_validation.result {
            return workspace_validation;
        }
    }

    match input.action {
        SessionControlAction::Create => {
            if input.workspace.is_none() {
                return invalid("workspace is required for create");
            }
            if input.session_id.is_some() {
                return invalid("session_id is not allowed for create");
            }
            if context.current_session_id.is_none() {
                return invalid("create requires a creator session in tool context");
            }
        }
        SessionControlAction::Cancel
        | SessionControlAction::Delete
        | SessionControlAction::Rename => {
            return validate_mutating_action_target(&input.action, input, context);
        }
        SessionControlAction::List => {
            if input.workspace.is_none() {
                return invalid("workspace is required for list");
            }
            if input.agent_type.is_some() {
                return invalid("agent_type is only allowed for create");
            }
            if input.session_name.is_some() {
                return invalid("session_name is only allowed for create");
            }
            if input.session_id.is_some() {
                return invalid("session_id is not allowed for list");
            }
        }
    }

    SessionControlValidationResult::default()
}

pub fn render_session_control_tool_use_message(input: &Value) -> String {
    let action = input
        .get("action")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown");
    let workspace = input
        .get("workspace")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown workspace");
    let session_id = input
        .get("session_id")
        .and_then(|value| value.as_str())
        .unwrap_or("auto");

    match action {
        "create" => format!("Create session in {workspace}"),
        "cancel" => format!("Cancel active turn for session {session_id}"),
        "delete" => format!("Delete session {session_id}"),
        "rename" => format!("Rename session {session_id}"),
        "list" => format!("List sessions in {workspace}"),
        _ => format!("Manage sessions in {workspace}"),
    }
}

pub fn session_control_created_result_message(
    session_id: &str,
    workspace: &str,
    agent_type: &str,
) -> String {
    format!("Created session '{session_id}' in workspace '{workspace}' using agent type '{agent_type}'.")
}

pub fn session_control_cancel_status(cancelled_turn_id: Option<&str>) -> &'static str {
    if cancelled_turn_id.is_some() {
        "cancel_requested"
    } else {
        "no_active_turn"
    }
}

pub fn session_control_cancel_result_message(
    session_id: &str,
    workspace: &str,
    cancelled_turn_id: Option<&str>,
) -> String {
    if let Some(turn_id) = cancelled_turn_id {
        format!(
            "Cancellation requested for the active turn '{turn_id}' in session '{session_id}' within workspace '{workspace}'. The session remains available for future work, and queued messages are not cleared."
        )
    } else {
        format!(
            "Session '{session_id}' in workspace '{workspace}' has no active turn to cancel. The session remains available for future work."
        )
    }
}

pub fn session_control_deleted_result_message(session_id: &str, workspace: &str) -> String {
    format!("Deleted session '{session_id}' from workspace '{workspace}'.")
}

pub fn session_control_renamed_result_message(
    session_id: &str,
    workspace: &str,
    session_name: &str,
) -> String {
    format!("Renamed session '{session_id}' to '{session_name}' in workspace '{workspace}'.")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn context(current: Option<&str>) -> SessionControlValidationContext<'_> {
        SessionControlValidationContext {
            current_session_id: current,
            has_workspace_root: true,
        }
    }

    #[test]
    fn rename_action_parses_payload_session_id_and_name() {
        let input: SessionControlInput = serde_json::from_value(json!({
            "action": "rename",
            "session_id": "worker_1",
            "session_name": "new-title",
        }))
        .expect("rename payload must parse");
        assert_eq!(input.action, SessionControlAction::Rename);
        assert_eq!(input.session_id.as_deref(), Some("worker_1"));
        assert_eq!(input.session_name.as_deref(), Some("new-title"));
        assert_eq!(SessionControlAction::Rename.as_str(), "rename");
    }

    #[test]
    fn rename_validation_requires_session_id() {
        let input = SessionControlInput {
            action: SessionControlAction::Rename,
            workspace: None,
            session_id: None,
            session_name: Some("new-title".to_string()),
            agent_type: None,
        };
        let result = validate_session_control_input(&input, context(None));
        assert!(!result.result);
        assert!(result
            .message
            .as_deref()
            .unwrap_or_default()
            .contains("session_id is required"));
    }

    #[test]
    fn rename_validation_requires_session_name() {
        let input = SessionControlInput {
            action: SessionControlAction::Rename,
            workspace: None,
            session_id: Some("worker_1".to_string()),
            session_name: None,
            agent_type: None,
        };
        let result = validate_session_control_input(&input, context(None));
        assert!(!result.result);
        assert!(result
            .message
            .as_deref()
            .unwrap_or_default()
            .contains("session_name is required for rename"));
    }

    #[test]
    fn rename_validation_rejects_blank_session_name() {
        let input = SessionControlInput {
            action: SessionControlAction::Rename,
            workspace: None,
            session_id: Some("worker_1".to_string()),
            session_name: Some("   ".to_string()),
            agent_type: None,
        };
        let result = validate_session_control_input(&input, context(None));
        assert!(!result.result);
        assert_eq!(
            result.message.as_deref(),
            Some("session_name must not be empty for rename")
        );
    }

    #[test]
    fn rename_validation_accepts_valid_input() {
        let input = SessionControlInput {
            action: SessionControlAction::Rename,
            workspace: None,
            session_id: Some("worker_1".to_string()),
            session_name: Some("new-title".to_string()),
            agent_type: None,
        };
        let result = validate_session_control_input(&input, context(None));
        assert!(result.result, "{:?}", result.message);
    }

    #[test]
    fn rename_validation_rejects_current_session() {
        let input = SessionControlInput {
            action: SessionControlAction::Rename,
            workspace: None,
            session_id: Some("self_1".to_string()),
            session_name: Some("new-title".to_string()),
            agent_type: None,
        };
        let result = validate_session_control_input(&input, context(Some("self_1")));
        assert!(!result.result);
        assert!(result
            .message
            .as_deref()
            .unwrap_or_default()
            .contains("cannot rename the current session"));
    }

    #[test]
    fn rename_render_mentions_session() {
        let rendered = render_session_control_tool_use_message(&json!({
            "action": "rename",
            "session_id": "worker_1",
        }));
        assert!(rendered.contains("Rename session"));
        assert!(rendered.contains("worker_1"));
    }

    #[test]
    fn renamed_result_message_mentions_id_and_new_name() {
        let message = session_control_renamed_result_message("worker_1", "/ws", "new-title");
        assert!(message.contains("worker_1"));
        assert!(message.contains("new-title"));
        assert!(message.contains("/ws"));
    }
}
