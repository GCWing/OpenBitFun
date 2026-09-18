use openbitfun_product_domains::tool_permissions::{PermissionReply, PermissionRequest};
use openbitfun_runtime_ports::{
    AgentContextReloadRequest, AgentDialogSteerRequest, AgentDialogTurnRequest,
    AgentMessageWorkspaceReferencesRequest, AgentSessionCompactionRequest,
    AgentSessionCreateRequest, AgentSessionCreateResult, AgentSessionLineageCancellationRequest,
    AgentSessionLineageInspection, AgentSessionLineageRequest, AgentSessionLineageSnapshot,
    AgentSessionLineageTranscriptRequest, AgentSessionListRequest, AgentSessionModeUpdateRequest,
    AgentSessionModelUpdateRequest, AgentSessionRevertRequest, AgentSessionRevertResult,
    AgentSessionSummary, AgentSessionUsageRequest, AgentSessionWorkspaceBinding,
    AgentTurnCancellationRequest, AgentTurnCancellationResult, AgentTurnSettlementRequest,
    AgentUserShellCommandRequest, AgentWorkspaceReference, AgentWorkspaceReferenceSearchRequest,
    AgentWorkspaceReferenceSearchResult, SessionTranscript, SessionUsageReport,
    WorkspaceDiffSnapshot,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeSessionRestoreRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// Upgrade-only pre-ID wire field.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub workspace_path: String,
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeSessionRenameRequest {
    pub session_id: String,
    pub session_name: String,
}

/// Forks the controlled Session at its latest persisted turn, or immediately
/// before `before_turn_id` when the TUI selected a historical user prompt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeSessionForkRequest {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before_turn_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeUserAnswersRequest {
    pub session_id: String,
    pub tool_id: String,
    pub answers: serde_json::Value,
}

/// Minimal host-owned main-agent catalog consumed by Shared TUI selectors.
/// Runtime generation keys and provider-specific source state never cross IPC.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeAgentModeSummary {
    pub id: String,
    #[serde(default)]
    pub route_key: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(default)]
    pub is_external: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum RuntimeSessionState {
    Idle,
    Processing {
        current_turn_id: String,
        phase: RuntimeSessionProcessingPhase,
    },
    Error {
        error: String,
        recoverable: bool,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeSessionProcessingPhase {
    Starting,
    Compacting,
    Thinking,
    Streaming,
    ToolCalling,
    ToolConfirming,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RuntimeIpcOperation {
    Health,
    ListAgentModes {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
    },
    ListSessions {
        request: AgentSessionListRequest,
    },
    CreateSession {
        request: AgentSessionCreateRequest,
    },
    RestoreSession {
        request: RuntimeSessionRestoreRequest,
    },
    DeleteSession {
        session_id: String,
    },
    UpdateSessionMode {
        request: AgentSessionModeUpdateRequest,
    },
    UpdateSessionModel {
        request: AgentSessionModelUpdateRequest,
    },
    RenameSession {
        request: RuntimeSessionRenameRequest,
    },
    ForkSession {
        request: RuntimeSessionForkRequest,
    },
    ReloadSessionContext {
        request: AgentContextReloadRequest,
    },
    CompactSession {
        request: AgentSessionCompactionRequest,
    },
    UndoSession {
        request: AgentSessionRevertRequest,
    },
    RedoSession {
        request: AgentSessionRevertRequest,
    },
    SessionUsage {
        request: AgentSessionUsageRequest,
    },
    WaitForSettlement {
        request: AgentTurnSettlementRequest,
    },
    SearchWorkspaceReferences {
        request: AgentWorkspaceReferenceSearchRequest,
    },
    WorkspaceReferencesForMessage {
        request: AgentMessageWorkspaceReferencesRequest,
    },
    GetSessionLineage {
        request: AgentSessionLineageRequest,
    },
    InspectLineageSession {
        request: AgentSessionLineageTranscriptRequest,
    },
    CancelLineageSession {
        request: AgentSessionLineageCancellationRequest,
    },
    WorkspaceDiff,
    SubmitTurn {
        request: AgentDialogTurnRequest,
    },
    SteerTurn {
        request: AgentDialogSteerRequest,
    },
    RunUserShellCommand {
        request: AgentUserShellCommandRequest,
    },
    CancelTurn {
        request: AgentTurnCancellationRequest,
    },
    PendingPermissions {
        session_id: String,
    },
    RespondPermission {
        session_id: String,
        request_id: String,
        reply: PermissionReply,
    },
    CancelUserQuestion {
        session_id: String,
        tool_id: String,
    },
    StartQuestionInteraction {
        session_id: String,
        tool_id: String,
    },
    SubmitUserAnswers {
        request: RuntimeUserAnswersRequest,
    },
}

impl RuntimeIpcOperation {
    /// These speculative reads may be superseded by a newer request from the
    /// same TUI connection. The server keeps their execution outside the
    /// connection's serial control path so cancellation and Session changes
    /// are never queued behind transcript I/O.
    pub(crate) fn is_interruptible_lineage_read(&self) -> bool {
        matches!(
            self,
            Self::GetSessionLineage { .. } | Self::InspectLineageSession { .. }
        )
    }

    pub fn session_id(&self) -> Option<&str> {
        match self {
            Self::ListAgentModes {
                session_id: Some(session_id),
            } => Some(session_id),
            Self::RestoreSession { request } => Some(&request.session_id),
            Self::DeleteSession { session_id } => Some(session_id),
            Self::UpdateSessionMode { request } => Some(&request.session_id),
            Self::UpdateSessionModel { request } => Some(&request.session_id),
            Self::RenameSession { request } => Some(&request.session_id),
            Self::ForkSession { request } => Some(&request.session_id),
            Self::ReloadSessionContext { request } => Some(&request.session_id),
            Self::CompactSession { request } => Some(&request.session_id),
            Self::UndoSession { request } => Some(&request.session_id),
            Self::RedoSession { request } => Some(&request.session_id),
            Self::SessionUsage { request } => Some(&request.session_id),
            Self::WaitForSettlement { request } => Some(&request.session_id),
            Self::SearchWorkspaceReferences { request } => Some(&request.session_id),
            Self::WorkspaceReferencesForMessage { request } => Some(&request.session_id),
            Self::GetSessionLineage { request } => Some(&request.anchor_session_id),
            Self::InspectLineageSession { request } => Some(&request.root_session_id),
            Self::CancelLineageSession { request } => Some(&request.root_session_id),
            Self::SubmitTurn { request } => Some(&request.session_id),
            Self::SteerTurn { request } => Some(&request.session_id),
            Self::RunUserShellCommand { request } => Some(&request.session_id),
            Self::CancelTurn { request } => Some(&request.session_id),
            Self::PendingPermissions { session_id }
            | Self::RespondPermission { session_id, .. } => Some(session_id),
            Self::StartQuestionInteraction { session_id, .. }
            | Self::CancelUserQuestion { session_id, .. } => Some(session_id),
            Self::SubmitUserAnswers { request } => Some(&request.session_id),
            Self::Health
            | Self::ListAgentModes { session_id: None }
            | Self::ListSessions { .. }
            | Self::CreateSession { .. }
            | Self::WorkspaceDiff => None,
        }
    }

    pub(crate) fn rules(&self) -> RuntimeIpcOperationRules {
        use RuntimeIpcSessionRequirement::{
            AttachExisting, CurrentController, None, UncontrolledTarget,
        };

        match self {
            Self::Health
            | Self::ListAgentModes {
                session_id: std::option::Option::None,
            }
            | Self::ListSessions { .. } => RuntimeIpcOperationRules::new(None, false, false, false),
            Self::ListAgentModes {
                session_id: Some(_),
            } => RuntimeIpcOperationRules::new(CurrentController, false, false, false),
            Self::WorkspaceDiff => RuntimeIpcOperationRules::new(None, true, false, false),
            Self::CreateSession { .. } => RuntimeIpcOperationRules::new(None, true, true, true),
            Self::RestoreSession { .. } => {
                RuntimeIpcOperationRules::new(AttachExisting, true, true, true)
            }
            Self::DeleteSession { .. } => {
                RuntimeIpcOperationRules::new(UncontrolledTarget, true, true, true)
            }
            Self::UpdateSessionMode { .. }
            | Self::UpdateSessionModel { .. }
            | Self::RenameSession { .. }
            | Self::CompactSession { .. }
            | Self::SubmitTurn { .. }
            | Self::RunUserShellCommand { .. } => {
                RuntimeIpcOperationRules::new(CurrentController, true, false, true)
            }
            Self::ForkSession { .. } => {
                RuntimeIpcOperationRules::new(CurrentController, true, true, true)
            }
            Self::ReloadSessionContext { .. }
            | Self::UndoSession { .. }
            | Self::RedoSession { .. }
            | Self::SteerTurn { .. }
            | Self::CancelTurn { .. }
            | Self::RespondPermission { .. }
            | Self::CancelUserQuestion { .. }
            | Self::StartQuestionInteraction { .. }
            | Self::SubmitUserAnswers { .. } => {
                RuntimeIpcOperationRules::new(CurrentController, false, false, true)
            }
            Self::PendingPermissions { .. } => {
                RuntimeIpcOperationRules::new(CurrentController, false, false, false)
            }
            Self::SessionUsage { .. } | Self::WaitForSettlement { .. } => {
                RuntimeIpcOperationRules::new(CurrentController, false, false, false)
            }
            Self::SearchWorkspaceReferences { .. } | Self::WorkspaceReferencesForMessage { .. } => {
                RuntimeIpcOperationRules::new(CurrentController, false, false, false)
            }
            Self::GetSessionLineage { .. } | Self::InspectLineageSession { .. } => {
                RuntimeIpcOperationRules::new(CurrentController, false, false, false)
            }
            Self::CancelLineageSession { .. } => {
                RuntimeIpcOperationRules::new(CurrentController, false, false, true)
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RuntimeIpcSessionRequirement {
    None,
    CurrentController,
    AttachExisting,
    UncontrolledTarget,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RuntimeIpcOperationRules {
    pub(crate) session_requirement: RuntimeIpcSessionRequirement,
    pub(crate) requires_idle: bool,
    pub(crate) serializes_session_selection: bool,
    pub(crate) side_effecting: bool,
}

impl RuntimeIpcOperationRules {
    const fn new(
        session_requirement: RuntimeIpcSessionRequirement,
        requires_idle: bool,
        serializes_session_selection: bool,
        side_effecting: bool,
    ) -> Self {
        Self {
            session_requirement,
            requires_idle,
            serializes_session_selection,
            side_effecting,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "result",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RuntimeIpcOperationResult {
    Health {
        instance_identity: String,
        process_id: u32,
    },
    Unit,
    AgentModes {
        modes: Vec<RuntimeAgentModeSummary>,
    },
    Sessions {
        sessions: Vec<AgentSessionSummary>,
    },
    SessionCreated {
        session: AgentSessionCreateResult,
    },
    SessionRestored {
        session: AgentSessionSummary,
        state: RuntimeSessionState,
        workspace_binding: AgentSessionWorkspaceBinding,
        transcript: SessionTranscript,
        pending_permissions: Vec<PermissionRequest>,
    },
    SessionForked {
        session: AgentSessionSummary,
        workspace_binding: AgentSessionWorkspaceBinding,
        transcript: SessionTranscript,
    },
    SessionReverted {
        revert: AgentSessionRevertResult,
    },
    SessionUsage {
        usage: SessionUsageReport,
    },
    SessionLineage {
        snapshot: Option<AgentSessionLineageSnapshot>,
    },
    LineageSessionInspection {
        inspection: AgentSessionLineageInspection,
    },
    TurnAccepted {
        session_id: String,
        turn_id: String,
    },
    TurnSteered {
        session_id: String,
        turn_id: String,
        steering_id: String,
    },
    TurnCancelled {
        cancellation: AgentTurnCancellationResult,
    },
    PendingPermissions {
        requests: Vec<PermissionRequest>,
    },
    WorkspaceReferenceSearch {
        search: AgentWorkspaceReferenceSearchResult,
    },
    WorkspaceReferences {
        references: Vec<AgentWorkspaceReference>,
    },
    WorkspaceDiff {
        snapshot: WorkspaceDiffSnapshot,
    },
}

#[cfg(test)]
mod tests {
    use super::{RuntimeIpcOperation, RuntimeIpcSessionRequirement, RuntimeSessionRestoreRequest};
    use openbitfun_runtime_ports::{
        AgentContextReloadRequest, AgentContextReloadTarget, AgentDialogSteerRequest,
        AgentSessionLineageCancellationRequest, AgentSessionLineageRequest,
        AgentSessionLineageTranscriptRequest,
    };

    #[test]
    fn delete_rules_are_fail_closed_for_shared_session_selection() {
        let rules = RuntimeIpcOperation::DeleteSession {
            session_id: "session-2".to_string(),
        }
        .rules();

        assert_eq!(
            rules.session_requirement,
            RuntimeIpcSessionRequirement::UncontrolledTarget
        );
        assert!(rules.requires_idle);
        assert!(rules.serializes_session_selection);
        assert!(rules.side_effecting);
    }

    #[test]
    fn reload_rules_preserve_active_turn_semantics_after_rule_consolidation() {
        let rules = RuntimeIpcOperation::ReloadSessionContext {
            request: AgentContextReloadRequest {
                session_id: "session-1".to_string(),
                target: AgentContextReloadTarget::All,
            },
        }
        .rules();

        assert_eq!(
            rules.session_requirement,
            RuntimeIpcSessionRequirement::CurrentController
        );
        assert!(!rules.requires_idle);
        assert!(!rules.serializes_session_selection);
        assert!(rules.side_effecting);
    }

    #[test]
    fn steer_rules_require_the_current_controller_but_allow_an_active_turn() {
        let operation = RuntimeIpcOperation::SteerTurn {
            request: AgentDialogSteerRequest {
                session_id: "session-1".to_string(),
                turn_id: "turn-1".to_string(),
                content: "check tests".to_string(),
                display_content: None,
                attachments: Vec::new(),
                metadata: serde_json::Map::new(),
            },
        };
        let rules = operation.rules();

        assert_eq!(operation.session_id(), Some("session-1"));
        assert_eq!(
            rules.session_requirement,
            RuntimeIpcSessionRequirement::CurrentController
        );
        assert!(!rules.requires_idle);
        assert!(!rules.serializes_session_selection);
        assert!(rules.side_effecting);
    }

    #[test]
    fn restore_and_pending_permission_rules_preserve_existing_behavior() {
        let restore = RuntimeIpcOperation::RestoreSession {
            request: RuntimeSessionRestoreRequest {
                workspace_id: None,
                workspace_path: "D:/workspace/project".to_string(),
                session_id: "session-2".to_string(),
            },
        }
        .rules();
        assert_eq!(
            restore.session_requirement,
            RuntimeIpcSessionRequirement::AttachExisting
        );
        assert!(restore.requires_idle);
        assert!(restore.serializes_session_selection);
        assert!(restore.side_effecting);

        let pending = RuntimeIpcOperation::PendingPermissions {
            session_id: "session-1".to_string(),
        }
        .rules();
        assert_eq!(
            pending.session_requirement,
            RuntimeIpcSessionRequirement::CurrentController
        );
        assert!(!pending.requires_idle);
        assert!(!pending.serializes_session_selection);
        assert!(!pending.side_effecting);
    }

    #[test]
    fn lineage_rules_keep_root_controller_and_allow_active_read_only_inspection() {
        let query = RuntimeIpcOperation::GetSessionLineage {
            request: AgentSessionLineageRequest {
                workspace_id: None,
                workspace_path: "D:/workspace/project".to_string(),
                anchor_session_id: "root-1".to_string(),
                remote_connection_id: None,
                remote_ssh_host: None,
            },
        };
        let inspect = RuntimeIpcOperation::InspectLineageSession {
            request: AgentSessionLineageTranscriptRequest {
                workspace_id: None,
                workspace_path: "D:/workspace/project".to_string(),
                root_session_id: "root-1".to_string(),
                session_id: "child-1".to_string(),
                required_settled_turn_ids: Vec::new(),
                remote_connection_id: None,
                remote_ssh_host: None,
            },
        };
        let cancel = RuntimeIpcOperation::CancelLineageSession {
            request: AgentSessionLineageCancellationRequest {
                workspace_id: None,
                workspace_path: "D:/workspace/project".to_string(),
                root_session_id: "root-1".to_string(),
                session_id: "child-1".to_string(),
                expected_active_turn_id: Some("turn-child".to_string()),
                source: None,
                reason: None,
                wait_timeout_ms: None,
                remote_connection_id: None,
                remote_ssh_host: None,
            },
        };

        for operation in [&query, &inspect] {
            let rules = operation.rules();
            assert_eq!(operation.session_id(), Some("root-1"));
            assert_eq!(
                rules.session_requirement,
                RuntimeIpcSessionRequirement::CurrentController
            );
            assert!(!rules.requires_idle);
            assert!(!rules.serializes_session_selection);
            assert!(!rules.side_effecting);
        }
        let cancel_rules = cancel.rules();
        assert_eq!(cancel.session_id(), Some("root-1"));
        assert_eq!(
            cancel_rules.session_requirement,
            RuntimeIpcSessionRequirement::CurrentController
        );
        assert!(!cancel_rules.requires_idle);
        assert!(!cancel_rules.serializes_session_selection);
        assert!(cancel_rules.side_effecting);
    }
}

/// Temporary serialization boundary for a pre-ID Shared Runtime (protocol 18).
/// Paths here are projections of an already selected host-owned workspace, never
/// lookup keys in current code. Remove when support for protocol 18 sunsets.
pub fn legacy_workspace_operation(
    operation: RuntimeIpcOperation,
    workspace_root: &str,
) -> RuntimeIpcOperation {
    use RuntimeIpcOperation::{ListSessions, RestoreSession};
    match operation {
        ListSessions { mut request } => {
            request.workspace_id = None;
            request.workspace_path = workspace_root.to_owned();
            ListSessions { request }
        }
        RestoreSession { mut request } => {
            request.workspace_id = None;
            request.workspace_path = workspace_root.to_owned();
            RestoreSession { request }
        }
        other => other,
    }
}
