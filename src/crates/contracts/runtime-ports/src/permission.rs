use crate::{PortError, PortResult, RuntimeServicePort};
use async_trait::async_trait;
use openbitfun_product_domains::tool_permissions::{
    PermissionAuditRecord, PermissionGrant, PermissionGrantKey,
};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

/// Safe, provider-neutral projection sent to an approval model. The projection
/// intentionally contains summaries rather than raw tool arguments or file
/// contents.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionDecisionInput {
    /// Local correlation key. It is never serialized into the model state.
    #[serde(skip_serializing)]
    pub request_id: String,
    pub action: String,
    pub tool_identity: String,
    #[serde(default)]
    pub resource_summaries: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_scope: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_user_message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delegation: Option<PermissionDecisionDelegation>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionDecisionDelegation {
    pub parent_session_id: String,
    pub parent_tool_call_id: String,
    pub subagent_type: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionDecisionOutcome {
    Allow,
    Ask,
    Deny,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionRiskClass {
    Low,
    Medium,
    High,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionReasonCode {
    ReadOnly,
    ReversibleChange,
    DestructiveChange,
    ExternalSideEffect,
    Credentials,
    ModelAsk,
    ModelDeny,
    ProviderError,
    ParseError,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionDecision {
    pub request_id: String,
    pub outcome: PermissionDecisionOutcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub probability: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub risk_class: Option<PermissionRiskClass>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<PermissionReasonCode>,
}

#[async_trait]
pub trait PermissionDecisionPort: Send + Sync {
    async fn evaluate(
        &self,
        batch: Vec<PermissionDecisionInput>,
        cancellation: CancellationToken,
    ) -> Result<Vec<PermissionDecision>, PortError>;
}

/// Persistent remembered-grant storage. Pending requests do not belong here.
#[async_trait]
pub trait PermissionGrantStorePort: RuntimeServicePort {
    async fn list_project_grants(&self, project_id: &str) -> PortResult<Vec<PermissionGrant>>;

    async fn add_project_grants(&self, grants: Vec<PermissionGrant>) -> PortResult<()>;

    async fn remove_project_grant(&self, key: PermissionGrantKey) -> PortResult<bool>;

    async fn clear_project_grants(&self, project_id: &str) -> PortResult<usize>;
}

/// Append-only permission audit persistence over presentation-safe DTOs.
#[async_trait]
pub trait PermissionAuditStorePort: RuntimeServicePort {
    async fn append_permission_audit(&self, record: PermissionAuditRecord) -> PortResult<()>;

    async fn list_project_permission_audit(
        &self,
        project_id: &str,
    ) -> PortResult<Vec<PermissionAuditRecord>>;
}

/// Atomically commits the durable effects of one permission reply.
#[async_trait]
pub trait PermissionReplyStorePort: RuntimeServicePort {
    async fn commit_permission_reply(
        &self,
        grants: Vec<PermissionGrant>,
        audit: Vec<PermissionAuditRecord>,
    ) -> PortResult<()>;
}
