//! External-source App Server wire schemas.
//!
//! These DTOs reuse the stable product-domain projections. Executable source
//! definitions and provider-private configuration never cross this boundary.

#[cfg(feature = "rpc")]
use agent_client_protocol::{JsonRpcNotification, JsonRpcRequest, JsonRpcResponse};
use openbitfun_product_domains::external_source_control::{
    ExternalSourceControlRequestV1, ExternalSourceControlSnapshotV1,
    ExternalSourceSurfaceSnapshotV1,
};
use openbitfun_product_domains::external_sources::{
    ExternalSourceOperationError, ExternalSourcePublicSnapshot,
    NativePromptCommandConflictSnapshot, NativePromptCommandDescriptor,
    PromptCommandInvocationOutcome, PromptCommandShellReviewDecision,
};
use openbitfun_product_domains::external_subagents::ExternalSubagentModelBindingTarget;
use serde::{Deserialize, Serialize};

pub use openbitfun_product_domains::external_sources::ExternalSourceConflictPreferences;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "externalSource/snapshot", response = ExternalSourceSnapshotResponse))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalSourceSnapshotRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// Upgrade-only field for pre-ID clients.
    #[serde(default)]
    pub workspace_path: String,
    pub force_refresh: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalSourceSnapshotResponse {
    pub control: ExternalSourceControlSnapshotV1,
    pub snapshot: ExternalSourcePublicSnapshot,
    pub preferences: ExternalSourceConflictPreferences,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcNotification))]
#[cfg_attr(feature = "rpc", notification(method = "externalSource/event"))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalSourceEventNotification {
    pub cursor: crate::event::EventCursor,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// Upgrade-only field for pre-ID clients.
    #[serde(default)]
    pub workspace_path: String,
    pub snapshot: ExternalSourcePublicSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "externalSource/control", response = ExternalSourceControlResponse))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalSourceControlRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// Upgrade-only field for pre-ID clients.
    #[serde(default)]
    pub workspace_path: String,
    pub request: ExternalSourceControlRequestV1,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalSourceControlResponse {
    pub surface: ExternalSourceSurfaceSnapshotV1,
    pub snapshot: ExternalSourceSnapshotResponse,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "externalSource/review", response = ExternalSourceReviewResponse))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalSourceReviewRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// Upgrade-only field for pre-ID clients.
    #[serde(default)]
    pub workspace_path: String,
    pub operation_id: String,
    pub action: ExternalSourceReviewAction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ExternalSourceReviewAction {
    Refresh,
    SetPromptCommandConflictChoice {
        conflict_key: String,
        candidate_id: String,
        expected_preference_revision: u64,
    },
    SetToolTargetDecision {
        approval_key: String,
        decision_key: String,
        approved: bool,
        expected_preference_revision: u64,
    },
    SetToolConflictChoice {
        conflict_key: String,
        candidate_id: String,
        expected_preference_revision: u64,
    },
    SetSubagentActivation {
        candidate_id: String,
        approved: bool,
        expected_subagent_generation: u64,
        expected_preference_revision: u64,
        decision_key: String,
    },
    SetSubagentModelBinding {
        binding_key: String,
        target: Option<ExternalSubagentModelBindingTarget>,
        expected_subagent_generation: u64,
        expected_preference_revision: u64,
    },
    ChooseSubagentConflict {
        conflict_key: String,
        candidate_id: String,
        approve_external: bool,
        expected_subagent_generation: u64,
        expected_preference_revision: u64,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
pub struct ExternalSourceReviewResponse(pub ExternalSourceSnapshotResponse);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(
    feature = "rpc",
    request(
        method = "externalSource/setNativeCommandChoice",
        response = SetNativeCommandChoiceResponse
    )
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetNativeCommandChoiceRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// Upgrade-only field for pre-ID clients.
    #[serde(default)]
    pub workspace_path: String,
    pub operation_id: String,
    pub native_commands: Vec<NativePromptCommandDescriptor>,
    pub selected_candidate_id: String,
    pub expected_preference_revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetNativeCommandChoiceResponse {
    pub conflicts: NativePromptCommandConflictSnapshot,
    pub preferences: ExternalSourceConflictPreferences,
}

#[derive(Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "externalSource/expandCommand", response = ExpandExternalCommandResponse))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExpandExternalCommandRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// Upgrade-only field for pre-ID clients.
    #[serde(default)]
    pub workspace_path: String,
    pub operation_id: String,
    pub command_name: String,
    pub arguments: String,
    pub native_commands: Vec<NativePromptCommandDescriptor>,
    pub candidate_id: Option<String>,
    pub content_version: Option<String>,
    pub native_conflict_key: Option<String>,
    pub expected_preference_revision: Option<u64>,
    pub shell_review_decision: Option<PromptCommandShellReviewDecision>,
}

impl std::fmt::Debug for ExpandExternalCommandRequest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ExpandExternalCommandRequest")
            .field("workspace_path", &"[REDACTED]")
            .field("operation_id", &self.operation_id)
            .field("command_name", &self.command_name)
            .field("arguments_bytes", &self.arguments.len())
            .field("native_command_count", &self.native_commands.len())
            .field("candidate_id", &self.candidate_id)
            .field("content_version", &self.content_version)
            .field("native_conflict_key", &self.native_conflict_key)
            .field(
                "expected_preference_revision",
                &self.expected_preference_revision,
            )
            .field(
                "shell_review_decision_configured",
                &self.shell_review_decision.is_some(),
            )
            .finish()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
pub struct ExpandExternalCommandResponse(pub PromptCommandInvocationOutcome);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalSourceErrorData {
    pub app: crate::error::AppServerErrorData,
    pub error: ExternalSourceOperationError,
}

pub fn validate_operation_id(value: &str) -> Result<(), &'static str> {
    if value.is_empty()
        || value.len() > 160
        || value.trim() != value
        || value.chars().any(char::is_control)
    {
        Err("invalid external source operation id")
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn operation_identity_is_required_and_bounded() {
        assert!(validate_operation_id("tui-operation-1").is_ok());
        assert!(validate_operation_id("").is_err());
        assert!(validate_operation_id(" leading").is_err());
        assert!(validate_operation_id(&"x".repeat(161)).is_err());
    }

    #[test]
    fn command_debug_redacts_workspace_and_arguments() {
        let request = ExpandExternalCommandRequest {
            workspace_id: Some("workspace-1".to_string()),
            workspace_path: "C:/secret/project".to_string(),
            operation_id: "operation-1".to_string(),
            command_name: "review".to_string(),
            arguments: "--token secret".to_string(),
            native_commands: Vec::new(),
            candidate_id: None,
            content_version: None,
            native_conflict_key: None,
            expected_preference_revision: None,
            shell_review_decision: None,
        };
        let debug = format!("{request:?}");
        assert!(!debug.contains("C:/secret/project"));
        assert!(!debug.contains("--token secret"));
    }
}
