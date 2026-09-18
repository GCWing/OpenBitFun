//! Agent-domain App Server wire schemas.

#[cfg(feature = "rpc")]
use agent_client_protocol::{JsonRpcRequest, JsonRpcResponse};
use openbitfun_product_domains::tool_permissions::{PermissionReply, PermissionRequest};
use openbitfun_runtime_ports::{
    AgentDialogSteerRequest, AgentDialogTurnExecution, AgentDialogTurnRequest,
    AgentInputAttachment, AgentSessionCreateRequest, AgentSessionCreateResult,
    AgentSessionDeleteRequest, AgentSessionListRequest, AgentSessionSummary,
    AgentSubmissionRequest, AgentSubmissionResult, AgentSubmissionSource,
    AgentTurnCancellationRequest, AgentTurnCancellationResult, AgentUserShellCommandRequest,
    AgentUserShellCommandResult, DialogSubmissionPolicy,
};
use serde::{Deserialize, Serialize};

macro_rules! unit_response {
    ($name:ident) => {
        #[derive(Debug, Clone, Serialize, Deserialize)]
        #[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
        pub struct $name {}
    };
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "agent/listModes", response = ListAgentModesResponse))]
#[serde(rename_all = "camelCase")]
pub struct ListAgentModesRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    #[serde(default)]
    pub include_external: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
pub struct ListAgentModesResponse {
    pub modes: Vec<AgentModeSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentModeSummary {
    pub id: String,
    #[serde(default)]
    pub route_key: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(default)]
    pub is_external: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "agent/listSessions", response = ListSessionsResponse))]
pub struct ListSessionsRequest(pub AgentSessionListRequest);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
/// `agent/listSessions` response body.
pub struct ListSessionsResponse {
    pub sessions: Vec<AgentSessionSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "agent/steerTurn", response = SteerTurnResponse))]
pub struct SteerTurnRequest(pub AgentDialogSteerRequest);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
pub struct SteerTurnResponse {
    pub steering_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "agent/runUserShellCommand", response = RunUserShellCommandResponse))]
pub struct RunUserShellCommandRequest(pub AgentUserShellCommandRequest);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
pub struct RunUserShellCommandResponse(pub AgentUserShellCommandResult);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "agent/submitUserAnswers", response = SubmitUserAnswersResponse))]
pub struct SubmitUserAnswersRequest {
    pub tool_id: String,
    pub answers: serde_json::Value,
}

unit_response!(SubmitUserAnswersResponse);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "agent/createSession", response = CreateSessionResponse))]
pub struct CreateSessionRequest(pub AgentSessionCreateRequest);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
pub struct CreateSessionResponse(pub AgentSessionCreateResult);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "agent/deleteSession", response = DeleteSessionResponse))]
pub struct DeleteSessionRequest(pub AgentSessionDeleteRequest);

unit_response!(DeleteSessionResponse);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "agent/submitDialogTurn", response = SubmitDialogTurnResponse))]
pub struct SubmitDialogTurnRequest(pub SubmitDialogTurnBody);

pub use SubmitDialogTurnRequest as SubmitDialogTurnMessage;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
/// Wire form of [`AgentDialogTurnRequest`] with an optional `policy`.
pub struct SubmitDialogTurnBody {
    pub session_id: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "AgentDialogTurnExecution::is_standard")]
    pub execution: AgentDialogTurnExecution,
    pub agent_type: String,
    /// Owning workspace ID; authoritative when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// Upgrade-only pre-ID storage selector. Current clients send `workspace_id`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub policy: Option<DialogSubmissionPolicy>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<AgentInputAttachment>,
    #[serde(default, skip_serializing_if = "serde_json::Map::is_empty")]
    pub metadata: serde_json::Map<String, serde_json::Value>,
}

impl SubmitDialogTurnBody {
    /// Project this wire body into the runtime contract using the adapter's
    /// explicit fallback policy when the legacy payload omits one.
    pub fn to_request(self, default_policy: DialogSubmissionPolicy) -> AgentDialogTurnRequest {
        AgentDialogTurnRequest {
            session_id: self.session_id,
            message: self.message,
            output_schema: None,
            original_message: self.original_message,
            turn_id: self.turn_id,
            execution: self.execution,
            agent_type: self.agent_type,
            workspace_path: self.workspace_path,
            workspace_id: self.workspace_id,
            remote_connection_id: self.remote_connection_id,
            remote_ssh_host: self.remote_ssh_host,
            policy: self.policy.unwrap_or(default_policy),
            reply_route: None,
            prepended_reminders: Vec::new(),
            attachments: self.attachments,
            metadata: self.metadata,
        }
    }
}

impl From<AgentDialogTurnRequest> for SubmitDialogTurnRequest {
    fn from(request: AgentDialogTurnRequest) -> Self {
        // The App Server wire contract predates reply routing and prepended
        // reminders. Keep the currently effective behavior: those runtime-only
        // fields are not sent over this compatibility method.
        Self(SubmitDialogTurnBody {
            session_id: request.session_id,
            message: request.message,
            original_message: request.original_message,
            turn_id: request.turn_id,
            execution: request.execution,
            agent_type: request.agent_type,
            workspace_id: request.workspace_id,
            workspace_path: request.workspace_path,
            remote_connection_id: request.remote_connection_id,
            remote_ssh_host: request.remote_ssh_host,
            policy: Some(request.policy),
            attachments: request.attachments,
            metadata: request.metadata,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase", tag = "status")]
/// `agent/submitDialogTurn` response body.
pub enum SubmitDialogTurnResponse {
    Started { session_id: String, turn_id: String },
    Queued { session_id: String, turn_id: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[cfg_attr(feature = "rpc", request(method = "agent/respondPermission", response = RespondPermissionResponse))]
pub struct RespondPermissionRequest {
    pub request_id: String,
    pub reply: PermissionReply,
}

unit_response!(RespondPermissionResponse);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "agent/listPendingPermissionRequests", response = PendingPermissionsResponse))]
pub struct PendingPermissionsRequest {}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
pub struct PendingPermissionsResponse {
    pub requests: Vec<PermissionRequest>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "agent/cancelTurn", response = CancelTurnResponse))]
pub struct CancelTurnRequest(pub AgentTurnCancellationRequest);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
pub struct CancelTurnResponse(pub AgentTurnCancellationResult);

pub use CancelTurnRequest as CancelTurnMessage;
pub use CreateSessionRequest as CreateSessionMessage;
pub use DeleteSessionRequest as DeleteSessionMessage;
pub use ListSessionsRequest as ListSessionsMessage;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "agent/submitTurn", response = SubmitTurnResponse))]
pub struct SubmitTurnMessage(pub AgentSubmissionRequest);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
pub struct SubmitTurnResponse(pub AgentSubmissionResult);

/// `agent/run` response body.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct RunResponse {
    pub session_id: String,
    pub turn_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<String>,
    #[serde(default)]
    pub accepted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum RunSessionSpec {
    Existing {
        session_id: String,
    },
    Create {
        session_name: String,
        agent_type: String,
        /// Owning workspace ID; authoritative when present.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        workspace_id: Option<String>,
        /// Legacy execution root for pre-ID clients.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        workspace_path: Option<String>,
    },
}

/// Compatibility request for `agent/run`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "agent/run", response = RunResponse))]
#[serde(rename_all = "camelCase")]
pub struct RunMessage {
    pub session: RunSessionSpec,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<AgentSubmissionSource>,
}
