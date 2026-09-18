//! Session-domain App Server wire schemas.

#[cfg(feature = "rpc")]
use agent_client_protocol::{JsonRpcRequest, JsonRpcResponse};
use openbitfun_core_types::SessionUsageReport;
use openbitfun_product_domains::tool_permissions::PermissionRequest;
use openbitfun_runtime_ports::{
    AgentContextReloadRequest, AgentSessionArchiveStateRequest, AgentSessionCompactionRequest,
    AgentSessionCompactionResult, AgentSessionForkAtTurnRequest, AgentSessionForkBeforeTurnRequest,
    AgentSessionForkRequest, AgentSessionForkResult, AgentSessionLineageCancellationRequest,
    AgentSessionLineageInspection, AgentSessionLineageRequest, AgentSessionLineageSnapshot,
    AgentSessionLineageTranscriptRequest, AgentSessionModeUpdateRequest,
    AgentSessionModelUpdateRequest, AgentSessionRenameRequest, AgentSessionRevertRequest,
    AgentSessionRevertResult, AgentSessionSummary, AgentSessionUsageRequest,
    AgentSessionWorkspaceBinding, AgentSessionWorkspaceRequest, AgentTurnCancellationResult,
    AgentTurnSettlementRequest, SessionTranscript, SessionTranscriptRequest,
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
#[cfg_attr(feature = "rpc", request(method = "session/sync", response = SyncSessionResponse))]
#[serde(rename_all = "camelCase")]
pub struct SyncSessionRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// Upgrade-only pre-ID wire field.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub workspace_path: String,
    pub session_id: String,
    #[serde(default)]
    pub include_internal: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
#[serde(rename_all = "camelCase")]
pub struct SyncSessionResponse {
    pub session: AgentSessionSummary,
    pub state: SessionRuntimeState,
    pub transcript: SessionTranscript,
    pub workspace_binding: AgentSessionWorkspaceBinding,
    #[serde(default)]
    pub pending_permissions: Vec<PermissionRequest>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SessionRuntimeState {
    Idle,
    Processing {
        current_turn_id: String,
        phase: SessionProcessingPhase,
    },
    Error {
        error: String,
        recoverable: bool,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub enum SessionProcessingPhase {
    Starting,
    Compacting,
    Thinking,
    Streaming,
    ToolCalling,
    ToolConfirming,
}

/// Compatibility request for `session/restore`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[cfg_attr(feature = "rpc", request(method = "session/restore", response = RestoreSessionResponse))]
#[serde(rename_all = "camelCase")]
pub struct RestoreSessionMessage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// Upgrade-only pre-ID wire field.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub workspace_path: String,
    pub session_id: String,
    #[serde(default)]
    pub include_internal: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct RestoreSessionResponse {
    pub session: AgentSessionSummary,
    pub state: SessionRuntimeState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "session/readTranscript", response = ReadTranscriptResponse))]
pub struct ReadTranscriptRequest(pub SessionTranscriptRequest);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
pub struct ReadTranscriptResponse(pub SessionTranscript);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "session/resolveWorkspace", response = ResolveWorkspaceResponse))]
pub struct ResolveWorkspaceRequest(pub AgentSessionWorkspaceRequest);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
pub struct ResolveWorkspaceResponse(pub Option<AgentSessionWorkspaceBinding>);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "session/rename", response = RenameSessionResponse))]
pub struct RenameSessionRequest(pub AgentSessionRenameRequest);

unit_response!(RenameSessionResponse);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "session/compact", response = CompactSessionResponse))]
pub struct CompactSessionRequest(pub AgentSessionCompactionRequest);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
pub struct CompactSessionResponse(pub AgentSessionCompactionResult);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "session/undo", response = RevertSessionResponse))]
pub struct UndoSessionRequest(pub AgentSessionRevertRequest);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "session/redo", response = RevertSessionResponse))]
pub struct RedoSessionRequest(pub AgentSessionRevertRequest);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
pub struct RevertSessionResponse(pub AgentSessionRevertResult);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "session/reloadContext", response = ReloadContextResponse))]
pub struct ReloadContextRequest(pub AgentContextReloadRequest);

unit_response!(ReloadContextResponse);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "session/usage", response = SessionUsageResponse))]
pub struct SessionUsageRequest(pub AgentSessionUsageRequest);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
pub struct SessionUsageResponse(pub SessionUsageReport);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "session/waitForSettlement", response = WaitForSettlementResponse))]
pub struct WaitForSettlementRequest(pub AgentTurnSettlementRequest);

unit_response!(WaitForSettlementResponse);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "session/lineage", response = SessionLineageResponse))]
pub struct SessionLineageRequest(pub AgentSessionLineageRequest);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
pub struct SessionLineageResponse(pub Option<AgentSessionLineageSnapshot>);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "session/inspectLineage", response = InspectLineageResponse))]
pub struct InspectLineageRequest(pub AgentSessionLineageTranscriptRequest);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
pub struct InspectLineageResponse(pub AgentSessionLineageInspection);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "session/cancelLineage", response = CancelLineageResponse))]
pub struct CancelLineageRequest(pub AgentSessionLineageCancellationRequest);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
pub struct CancelLineageResponse(pub AgentTurnCancellationResult);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "session/fork", response = ForkSessionResponse))]
pub struct ForkSessionRequest(pub AgentSessionForkRequest);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "session/forkBeforeTurn", response = ForkSessionResponse))]
pub struct ForkSessionBeforeTurnRequest(pub AgentSessionForkBeforeTurnRequest);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct ForkSessionResponse(pub AgentSessionForkResult);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "session/updateModel", response = UpdateSessionModelResponse))]
pub struct UpdateSessionModelRequest(pub AgentSessionModelUpdateRequest);

unit_response!(UpdateSessionModelResponse);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "session/updateMode", response = UpdateSessionModeResponse))]
pub struct UpdateSessionModeRequest(pub AgentSessionModeUpdateRequest);

unit_response!(UpdateSessionModeResponse);

pub use ForkSessionBeforeTurnRequest as ForkSessionBeforeTurnMessage;
pub use ForkSessionRequest as ForkSessionMessage;
pub use RenameSessionRequest as RenameSessionMessage;
pub use UpdateSessionModeRequest as UpdateSessionModeMessage;
pub use UpdateSessionModelRequest as UpdateSessionModelMessage;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[cfg_attr(feature = "rpc", request(method = "session/setArchived", response = SetSessionArchivedResponse))]
pub struct SetSessionArchivedMessage(pub AgentSessionArchiveStateRequest);

unit_response!(SetSessionArchivedResponse);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[cfg_attr(feature = "rpc", request(method = "session/forkAtTurn", response = ForkSessionResponse))]
pub struct ForkSessionAtTurnMessage(pub AgentSessionForkAtTurnRequest);
