//! Internal Agent Runtime facade over stable runtime ports.
//!
//! This module is intentionally port-backed for product assembly and internal
//! runtime owners. Client-facing SDK consumers should use `crate::sdk`, which
//! does not expose raw PluginRuntimeClient contracts.

use std::sync::{Arc, Mutex};

use openbitfun_agent_tools::{ToolRegistry, ToolRegistryItem};
use openbitfun_runtime_ports::{
    AgentBackgroundResultRequest, AgentDialogSteerRequest, AgentDialogTurnPort,
    AgentDialogTurnRecoveryOutcome, AgentDialogTurnRecoveryRequest, AgentDialogTurnRequest,
    AgentInputAttachment, AgentInteractionResponsePort, AgentLifecycleDeliveryPort,
    AgentLocalCommandTurnPort, AgentLocalCommandTurnRecordRequest,
    AgentLocalCommandTurnRecordResult, AgentMessageWorkspaceReferencesRequest,
    AgentModeCatalogEntry, AgentModeCatalogPort, AgentModeCatalogQuery, AgentSessionArchiveRequest,
    AgentSessionArchiveStateRequest, AgentSessionClosePort, AgentSessionCompactionPort,
    AgentSessionCompactionRequest, AgentSessionCompactionResult, AgentSessionCreateRequest,
    AgentSessionCreateResult, AgentSessionDeleteRequest, AgentSessionForkAtTurnRequest,
    AgentSessionForkBeforeTurnRequest, AgentSessionForkPort, AgentSessionForkRequest,
    AgentSessionForkResult, AgentSessionLineageCancellationRequest, AgentSessionLineageInspection,
    AgentSessionLineagePort, AgentSessionLineageRequest, AgentSessionLineageSnapshot,
    AgentSessionLineageTranscriptRequest, AgentSessionListRequest, AgentSessionManagementPort,
    AgentSessionModePort, AgentSessionModeUpdateRequest, AgentSessionModelPort,
    AgentSessionModelSelectionUpdateRequest, AgentSessionModelUpdateRequest,
    AgentSessionReleaseRequest, AgentSessionRenameRequest, AgentSessionRevertPort,
    AgentSessionRevertRequest, AgentSessionRevertResult, AgentSessionRollbackToTurnOutcome,
    AgentSessionRollbackToTurnRequest, AgentSessionSummary, AgentSessionUsagePort,
    AgentSessionUsageRequest, AgentSessionWorkspaceBinding, AgentSessionWorkspaceRequest,
    AgentSubmissionPort, AgentSubmissionRequest, AgentSubmissionResult, AgentSubmissionSource,
    AgentThreadGoalCreateRequest, AgentThreadGoalDeliveryRequest, AgentThreadGoalGetRequest,
    AgentThreadGoalManagementPort, AgentThreadGoalUpdateStatusRequest,
    AgentTransientSessionDiscardRequest, AgentTurnCancellationPort, AgentTurnCancellationRequest,
    AgentTurnCancellationResult, AgentTurnInterruptionRequest, AgentTurnInterruptionResult,
    AgentTurnSettlementPort, AgentTurnSettlementRequest, AgentTurnSettlementResult,
    AgentUserAnswersRequest, AgentUserShellCommandPort, AgentUserShellCommandRequest,
    AgentUserShellCommandResult, AgentWorkspaceReference, AgentWorkspaceReferencePort,
    AgentWorkspaceReferenceSearchRequest, AgentWorkspaceReferenceSearchResult, DialogSteerOutcome,
    DialogSubmitOutcome, PermissionAuditRecord, PermissionGrant, PermissionGrantKey,
    PluginRuntimeBinding, PortError, PortErrorKind, PortResult, RuntimeEventEnvelope,
    SessionTranscript, SessionTranscriptReader, SessionTranscriptRequest, ThreadGoal,
    WorkspaceDiffSnapshot,
};
use openbitfun_runtime_services::RuntimeServices;

use crate::event_source::{AgentEventReceiver, AgentEventSource, AgentSessionEventReceiver};
use crate::permission::{
    PermissionRequestEventReceiver, PermissionRequestManager, PermissionRequestSnapshot,
};
use crate::post_call_hooks::RuntimeHookRegistry;
use crate::user_questions::{get_user_input_manager, PendingUserQuestionSnapshot};
use openbitfun_runtime_ports::{PermissionReply, PermissionReplySource, PermissionRequest};

#[path = "session_event_journal.rs"]
mod session_event_journal;
pub use session_event_journal::{
    attach_session_event_cursor, SessionEventBackfill, SessionEventCursor, SessionEventJournal,
    SessionEventProjectionSnapshot, SessionEventProjectionStore, StoredSessionEvents,
    RUNTIME_EVENT_CURSOR_KEY, RUNTIME_EVENT_STREAM_ID_KEY,
};

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RuntimeBuildError {
    #[error("agent submission port is required")]
    MissingSubmissionPort,
    #[error("plugin runtime client binding must report executable availability")]
    UnsupportedPluginRuntimeClientAvailability,
    #[error("permission request manager is unavailable: {0}")]
    PermissionRequestManagerUnavailable(String),
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RuntimeError {
    #[error("agent dialog turn port is not registered")]
    MissingDialogTurnPort,
    #[error("agent lifecycle delivery port is not registered")]
    MissingLifecycleDeliveryPort,
    #[error("agent cancellation port is not registered")]
    MissingCancellationPort,
    #[error("agent session management port is not registered")]
    MissingSessionManagementPort,
    #[error("agent session lineage port is not registered")]
    MissingSessionLineagePort,
    #[error("agent workspace reference port is not registered")]
    MissingWorkspaceReferencePort,
    #[error("agent session restore port is not registered")]
    MissingSessionRestorePort,
    #[error("agent local command turn port is not registered")]
    MissingLocalCommandTurnPort,
    #[error("session transcript reader is not registered")]
    MissingSessionTranscriptReader,
    #[error("agent thread goal management port is not registered")]
    MissingThreadGoalManagementPort,
    #[error("agent interaction response port is not registered")]
    MissingInteractionResponsePort,
    #[error("runtime event sink is not registered")]
    MissingEventSink,
    #[error("agent event source is not registered")]
    MissingEventSource,
    #[error("permission request manager is not registered")]
    MissingPermissionRequestManager,
    #[error("permission request failed: {0}")]
    PermissionRequest(String),
    #[error(transparent)]
    Port(#[from] PortError),
}

impl RuntimeError {
    /// Returns the provider message without prepending the structured port error kind.
    pub fn into_message(self) -> String {
        match self {
            Self::Port(error) => error.message,
            other => other.to_string(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionRestoreRequest {
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

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionRestoreResult {
    pub session: AgentSessionSummary,
    pub state: crate::session_state::SessionState,
}

/// Authoritative live interactions required to re-attach a product Surface to
/// a running Session after missing push events.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInteractionSnapshot {
    pub session_id: String,
    #[serde(default)]
    pub user_questions: PendingUserQuestionSnapshot,
    #[serde(default)]
    pub permissions: PermissionRequestSnapshot,
}

#[async_trait::async_trait]
pub trait AgentSessionRestorePort: Send + Sync {
    async fn restore_session(
        &self,
        request: AgentSessionRestoreRequest,
    ) -> PortResult<AgentSessionRestoreResult>;
}

#[derive(Clone, Default)]
pub struct AgentEventStream {
    events: Arc<Mutex<Vec<RuntimeEventEnvelope>>>,
}

impl std::fmt::Debug for AgentEventStream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AgentEventStream")
            .field("len", &self.len())
            .finish()
    }
}

impl AgentEventStream {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn len(&self) -> usize {
        self.events.lock().unwrap().len()
    }

    pub fn snapshot(&self) -> Vec<RuntimeEventEnvelope> {
        self.events.lock().unwrap().clone()
    }

    pub fn drain(&self) -> Vec<RuntimeEventEnvelope> {
        self.events.lock().unwrap().drain(..).collect()
    }

    fn push(&self, event: RuntimeEventEnvelope) {
        self.events.lock().unwrap().push(event);
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct RuntimeAgentRegistryQuery<'a> {
    pub workspace_id: Option<&'a str>,
}

pub trait RuntimeAgentRegistry: Send + Sync {
    fn agent_ids(&self, query: RuntimeAgentRegistryQuery<'_>) -> Vec<String>;
}

#[derive(Clone)]
pub struct AgentRuntime {
    submission: Arc<dyn AgentSubmissionPort>,
    session_management: Option<Arc<dyn AgentSessionManagementPort>>,
    session_lineage: Option<Arc<dyn AgentSessionLineagePort>>,
    workspace_references: Option<Arc<dyn AgentWorkspaceReferencePort>>,
    session_close: Option<Arc<dyn AgentSessionClosePort>>,
    session_mode: Option<Arc<dyn AgentSessionModePort>>,
    session_model: Option<Arc<dyn AgentSessionModelPort>>,
    session_compaction: Option<Arc<dyn AgentSessionCompactionPort>>,
    session_revert: Option<Arc<dyn AgentSessionRevertPort>>,
    session_fork: Option<Arc<dyn AgentSessionForkPort>>,
    session_usage: Option<Arc<dyn AgentSessionUsagePort>>,
    turn_settlement: Option<Arc<dyn AgentTurnSettlementPort>>,
    session_restore: Option<Arc<dyn AgentSessionRestorePort>>,
    local_command_turn: Option<Arc<dyn AgentLocalCommandTurnPort>>,
    user_shell_command: Option<Arc<dyn AgentUserShellCommandPort>>,
    session_transcript_reader: Option<Arc<dyn SessionTranscriptReader>>,
    thread_goal_management: Option<Arc<dyn AgentThreadGoalManagementPort>>,
    dialog_turn: Option<Arc<dyn AgentDialogTurnPort>>,
    lifecycle_delivery: Option<Arc<dyn AgentLifecycleDeliveryPort>>,
    cancellation: Option<Arc<dyn AgentTurnCancellationPort>>,
    interaction_response: Option<Arc<dyn AgentInteractionResponsePort>>,
    permission_requests: Option<Arc<PermissionRequestManager>>,
    services: Option<RuntimeServices>,
    event_stream: Option<AgentEventStream>,
    event_source: Option<AgentEventSource>,
    session_event_journal: Option<Arc<SessionEventJournal>>,
    tool_registry: Option<Arc<dyn RuntimeToolRegistry>>,
    hook_registry: RuntimeHookRegistry,
    agent_registry: Option<Arc<dyn RuntimeAgentRegistry>>,
    mode_catalog: Option<Arc<dyn AgentModeCatalogPort>>,
    plugin_runtime: PluginRuntimeBinding,
}

impl std::fmt::Debug for AgentRuntime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AgentRuntime")
            .field("submission", &"<dyn AgentSubmissionPort>")
            .field(
                "session_management",
                &self
                    .session_management
                    .as_ref()
                    .map(|_| "<dyn AgentSessionManagementPort>"),
            )
            .field(
                "session_lineage",
                &self
                    .session_lineage
                    .as_ref()
                    .map(|_| "<dyn AgentSessionLineagePort>"),
            )
            .field(
                "workspace_references",
                &self
                    .workspace_references
                    .as_ref()
                    .map(|_| "<dyn AgentWorkspaceReferencePort>"),
            )
            .field(
                "session_close",
                &self
                    .session_close
                    .as_ref()
                    .map(|_| "<dyn AgentSessionClosePort>"),
            )
            .field(
                "session_mode",
                &self
                    .session_mode
                    .as_ref()
                    .map(|_| "<dyn AgentSessionModePort>"),
            )
            .field(
                "session_model",
                &self
                    .session_model
                    .as_ref()
                    .map(|_| "<dyn AgentSessionModelPort>"),
            )
            .field(
                "session_compaction",
                &self
                    .session_compaction
                    .as_ref()
                    .map(|_| "<dyn AgentSessionCompactionPort>"),
            )
            .field(
                "session_fork",
                &self
                    .session_fork
                    .as_ref()
                    .map(|_| "<dyn AgentSessionForkPort>"),
            )
            .field(
                "session_revert",
                &self
                    .session_revert
                    .as_ref()
                    .map(|_| "<dyn AgentSessionRevertPort>"),
            )
            .field(
                "session_usage",
                &self
                    .session_usage
                    .as_ref()
                    .map(|_| "<dyn AgentSessionUsagePort>"),
            )
            .field(
                "turn_settlement",
                &self
                    .turn_settlement
                    .as_ref()
                    .map(|_| "<dyn AgentTurnSettlementPort>"),
            )
            .field(
                "session_restore",
                &self
                    .session_restore
                    .as_ref()
                    .map(|_| "<dyn AgentSessionRestorePort>"),
            )
            .field(
                "local_command_turn",
                &self
                    .local_command_turn
                    .as_ref()
                    .map(|_| "<dyn AgentLocalCommandTurnPort>"),
            )
            .field(
                "user_shell_command",
                &self
                    .user_shell_command
                    .as_ref()
                    .map(|_| "<dyn AgentUserShellCommandPort>"),
            )
            .field(
                "session_transcript_reader",
                &self
                    .session_transcript_reader
                    .as_ref()
                    .map(|_| "<dyn SessionTranscriptReader>"),
            )
            .field(
                "thread_goal_management",
                &self
                    .thread_goal_management
                    .as_ref()
                    .map(|_| "<dyn AgentThreadGoalManagementPort>"),
            )
            .field(
                "dialog_turn",
                &self
                    .dialog_turn
                    .as_ref()
                    .map(|_| "<dyn AgentDialogTurnPort>"),
            )
            .field(
                "lifecycle_delivery",
                &self
                    .lifecycle_delivery
                    .as_ref()
                    .map(|_| "<dyn AgentLifecycleDeliveryPort>"),
            )
            .field(
                "cancellation",
                &self
                    .cancellation
                    .as_ref()
                    .map(|_| "<dyn AgentTurnCancellationPort>"),
            )
            .field(
                "interaction_response",
                &self
                    .interaction_response
                    .as_ref()
                    .map(|_| "<dyn AgentInteractionResponsePort>"),
            )
            .field(
                "services",
                &self.services.as_ref().map(|_| "<RuntimeServices>"),
            )
            .field(
                "event_stream",
                &self.event_stream.as_ref().map(|_| "<AgentEventStream>"),
            )
            .field(
                "event_source",
                &self.event_source.as_ref().map(|_| "<AgentEventSource>"),
            )
            .field(
                "session_event_journal",
                &self
                    .session_event_journal
                    .as_ref()
                    .map(|_| "<SessionEventJournal>"),
            )
            .field(
                "tool_registry",
                &self.tool_registry.as_ref().map(|_| "<RuntimeToolRegistry>"),
            )
            .field("hook_count", &self.hook_registry.hooks().len())
            .field(
                "agent_registry",
                &self
                    .agent_registry
                    .as_ref()
                    .map(|_| "<dyn RuntimeAgentRegistry>"),
            )
            .field("plugin_runtime", &self.plugin_runtime.availability())
            .finish()
    }
}

pub trait RuntimeToolRegistry: Send + Sync {
    fn tool_names(&self) -> Vec<String>;
}

impl<Tool> RuntimeToolRegistry for ToolRegistry<Tool>
where
    Tool: ToolRegistryItem + ?Sized,
{
    fn tool_names(&self) -> Vec<String> {
        self.get_tool_names()
    }
}

#[derive(Default, Clone)]
pub struct AgentRuntimeBuilder {
    submission: Option<Arc<dyn AgentSubmissionPort>>,
    session_management: Option<Arc<dyn AgentSessionManagementPort>>,
    session_lineage: Option<Arc<dyn AgentSessionLineagePort>>,
    workspace_references: Option<Arc<dyn AgentWorkspaceReferencePort>>,
    session_close: Option<Arc<dyn AgentSessionClosePort>>,
    session_mode: Option<Arc<dyn AgentSessionModePort>>,
    session_model: Option<Arc<dyn AgentSessionModelPort>>,
    session_compaction: Option<Arc<dyn AgentSessionCompactionPort>>,
    session_revert: Option<Arc<dyn AgentSessionRevertPort>>,
    session_fork: Option<Arc<dyn AgentSessionForkPort>>,
    session_usage: Option<Arc<dyn AgentSessionUsagePort>>,
    turn_settlement: Option<Arc<dyn AgentTurnSettlementPort>>,
    session_restore: Option<Arc<dyn AgentSessionRestorePort>>,
    local_command_turn: Option<Arc<dyn AgentLocalCommandTurnPort>>,
    user_shell_command: Option<Arc<dyn AgentUserShellCommandPort>>,
    session_transcript_reader: Option<Arc<dyn SessionTranscriptReader>>,
    thread_goal_management: Option<Arc<dyn AgentThreadGoalManagementPort>>,
    dialog_turn: Option<Arc<dyn AgentDialogTurnPort>>,
    lifecycle_delivery: Option<Arc<dyn AgentLifecycleDeliveryPort>>,
    cancellation: Option<Arc<dyn AgentTurnCancellationPort>>,
    interaction_response: Option<Arc<dyn AgentInteractionResponsePort>>,
    permission_requests: Option<Arc<PermissionRequestManager>>,
    services: Option<RuntimeServices>,
    event_stream: Option<AgentEventStream>,
    event_source: Option<AgentEventSource>,
    session_event_journal: Option<Arc<SessionEventJournal>>,
    tool_registry: Option<Arc<dyn RuntimeToolRegistry>>,
    hook_registry: RuntimeHookRegistry,
    agent_registry: Option<Arc<dyn RuntimeAgentRegistry>>,
    mode_catalog: Option<Arc<dyn AgentModeCatalogPort>>,
    plugin_runtime: PluginRuntimeBinding,
}

impl AgentRuntimeBuilder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_submission_port(mut self, port: Arc<dyn AgentSubmissionPort>) -> Self {
        self.submission = Some(port);
        self
    }

    pub fn with_session_management_port(
        mut self,
        port: Arc<dyn AgentSessionManagementPort>,
    ) -> Self {
        self.session_management = Some(port);
        self
    }

    pub fn with_session_lineage_port(mut self, port: Arc<dyn AgentSessionLineagePort>) -> Self {
        self.session_lineage = Some(port);
        self
    }

    pub fn with_workspace_reference_port(
        mut self,
        port: Arc<dyn AgentWorkspaceReferencePort>,
    ) -> Self {
        self.workspace_references = Some(port);
        self
    }

    pub fn with_session_close_port(mut self, port: Arc<dyn AgentSessionClosePort>) -> Self {
        self.session_close = Some(port);
        self
    }

    pub fn with_session_model_port(mut self, port: Arc<dyn AgentSessionModelPort>) -> Self {
        self.session_model = Some(port);
        self
    }

    pub fn with_session_mode_port(mut self, port: Arc<dyn AgentSessionModePort>) -> Self {
        self.session_mode = Some(port);
        self
    }

    pub fn with_session_compaction_port(
        mut self,
        port: Arc<dyn AgentSessionCompactionPort>,
    ) -> Self {
        self.session_compaction = Some(port);
        self
    }

    pub fn with_session_revert_port(mut self, port: Arc<dyn AgentSessionRevertPort>) -> Self {
        self.session_revert = Some(port);
        self
    }

    pub fn with_session_fork_port(mut self, port: Arc<dyn AgentSessionForkPort>) -> Self {
        self.session_fork = Some(port);
        self
    }

    pub fn with_session_usage_port(mut self, port: Arc<dyn AgentSessionUsagePort>) -> Self {
        self.session_usage = Some(port);
        self
    }

    pub fn with_turn_settlement_port(mut self, port: Arc<dyn AgentTurnSettlementPort>) -> Self {
        self.turn_settlement = Some(port);
        self
    }

    pub fn with_session_restore_port(mut self, port: Arc<dyn AgentSessionRestorePort>) -> Self {
        self.session_restore = Some(port);
        self
    }

    pub fn with_local_command_turn_port(
        mut self,
        port: Arc<dyn AgentLocalCommandTurnPort>,
    ) -> Self {
        self.local_command_turn = Some(port);
        self
    }

    pub fn with_user_shell_command_port(
        mut self,
        port: Arc<dyn AgentUserShellCommandPort>,
    ) -> Self {
        self.user_shell_command = Some(port);
        self
    }

    pub fn with_session_transcript_reader(
        mut self,
        reader: Arc<dyn SessionTranscriptReader>,
    ) -> Self {
        self.session_transcript_reader = Some(reader);
        self
    }

    pub fn with_thread_goal_management_port(
        mut self,
        port: Arc<dyn AgentThreadGoalManagementPort>,
    ) -> Self {
        self.thread_goal_management = Some(port);
        self
    }

    pub fn with_dialog_turn_port(mut self, port: Arc<dyn AgentDialogTurnPort>) -> Self {
        self.dialog_turn = Some(port);
        self
    }

    pub fn with_lifecycle_delivery_port(
        mut self,
        port: Arc<dyn AgentLifecycleDeliveryPort>,
    ) -> Self {
        self.lifecycle_delivery = Some(port);
        self
    }

    pub fn with_cancellation_port(mut self, port: Arc<dyn AgentTurnCancellationPort>) -> Self {
        self.cancellation = Some(port);
        self
    }

    pub fn with_interaction_response_port(
        mut self,
        port: Arc<dyn AgentInteractionResponsePort>,
    ) -> Self {
        self.interaction_response = Some(port);
        self
    }

    pub fn with_permission_request_manager(
        mut self,
        manager: Arc<PermissionRequestManager>,
    ) -> Self {
        self.permission_requests = Some(manager);
        self
    }

    pub fn with_services(mut self, services: RuntimeServices) -> Self {
        self.services = Some(services);
        self
    }

    pub fn with_event_stream(mut self, events: AgentEventStream) -> Self {
        self.event_stream = Some(events);
        self
    }

    pub fn with_event_source(mut self, source: AgentEventSource) -> Self {
        self.event_source = Some(source);
        self
    }

    pub fn with_session_event_journal(mut self, journal: Arc<SessionEventJournal>) -> Self {
        self.session_event_journal = Some(journal);
        self
    }

    pub fn with_tool_registry(mut self, registry: Arc<dyn RuntimeToolRegistry>) -> Self {
        self.tool_registry = Some(registry);
        self
    }

    pub fn with_hook_registry(mut self, registry: RuntimeHookRegistry) -> Self {
        self.hook_registry = registry;
        self
    }

    pub fn with_agent_registry(mut self, registry: Arc<dyn RuntimeAgentRegistry>) -> Self {
        self.agent_registry = Some(registry);
        self
    }

    pub fn with_mode_catalog(mut self, port: Arc<dyn AgentModeCatalogPort>) -> Self {
        self.mode_catalog = Some(port);
        self
    }

    pub fn with_plugin_runtime(mut self, binding: PluginRuntimeBinding) -> Self {
        self.plugin_runtime = binding;
        self
    }

    pub fn build(self) -> Result<AgentRuntime, RuntimeBuildError> {
        let Self {
            submission,
            session_management,
            session_lineage,
            workspace_references,
            session_close,
            session_mode,
            session_model,
            session_compaction,
            session_revert,
            session_fork,
            session_usage,
            turn_settlement,
            session_restore,
            local_command_turn,
            user_shell_command,
            session_transcript_reader,
            thread_goal_management,
            dialog_turn,
            lifecycle_delivery,
            cancellation,
            interaction_response,
            permission_requests,
            services,
            event_stream,
            event_source,
            session_event_journal,
            tool_registry,
            hook_registry,
            agent_registry,
            mode_catalog,
            plugin_runtime,
        } = self;

        if plugin_runtime.is_client_binding() && !plugin_runtime.availability().is_executable() {
            return Err(RuntimeBuildError::UnsupportedPluginRuntimeClientAvailability);
        }

        Ok(AgentRuntime {
            submission: submission.ok_or(RuntimeBuildError::MissingSubmissionPort)?,
            session_management,
            session_lineage,
            workspace_references,
            session_close,
            session_mode,
            session_model,
            session_compaction,
            session_revert,
            session_fork,
            session_usage,
            turn_settlement,
            session_restore,
            local_command_turn,
            user_shell_command,
            session_transcript_reader,
            thread_goal_management,
            dialog_turn,
            lifecycle_delivery,
            cancellation,
            interaction_response,
            permission_requests,
            services,
            event_stream,
            event_source,
            session_event_journal,
            tool_registry,
            hook_registry,
            agent_registry,
            mode_catalog,
            plugin_runtime,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionSelector {
    Existing {
        session_id: String,
    },
    Create {
        session_name: String,
        agent_type: String,
        /// Owning workspace ID; authoritative when present.
        workspace_id: Option<String>,
        /// Legacy execution root for pre-ID callers.
        workspace_path: Option<String>,
        metadata: serde_json::Map<String, serde_json::Value>,
    },
}

impl SessionSelector {
    pub fn existing(session_id: impl Into<String>) -> Self {
        Self::Existing {
            session_id: session_id.into(),
        }
    }

    pub fn create(
        session_name: impl Into<String>,
        agent_type: impl Into<String>,
        workspace_path: Option<String>,
    ) -> Self {
        Self::Create {
            session_name: session_name.into(),
            agent_type: agent_type.into(),
            workspace_id: None,
            workspace_path,
            metadata: serde_json::Map::new(),
        }
    }

    /// Select the owning workspace by ID. The path, when also present, is
    /// only an IO projection for hosts that still record it.
    pub fn with_workspace_id(mut self, workspace_id: Option<String>) -> Self {
        if let Self::Create {
            workspace_id: slot, ..
        } = &mut self
        {
            *slot = workspace_id
                .map(|id| id.trim().to_string())
                .filter(|id| !id.is_empty());
        }
        self
    }

    pub fn with_metadata(mut self, metadata: serde_json::Map<String, serde_json::Value>) -> Self {
        if let Self::Create {
            metadata: existing, ..
        } = &mut self
        {
            *existing = metadata;
        }
        self
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct AgentRunRequest {
    pub session: SessionSelector,
    pub message: String,
    pub turn_id: Option<String>,
    pub source: Option<AgentSubmissionSource>,
    pub attachments: Vec<AgentInputAttachment>,
    pub metadata: serde_json::Map<String, serde_json::Value>,
}

impl AgentRunRequest {
    pub fn new(session: SessionSelector, message: impl Into<String>) -> Self {
        Self {
            session,
            message: message.into(),
            turn_id: None,
            source: None,
            attachments: Vec::new(),
            metadata: serde_json::Map::new(),
        }
    }

    pub fn with_turn_id(mut self, turn_id: impl Into<String>) -> Self {
        self.turn_id = Some(turn_id.into());
        self
    }

    pub fn with_source(mut self, source: AgentSubmissionSource) -> Self {
        self.source = Some(source);
        self
    }

    pub fn with_attachments(mut self, attachments: Vec<AgentInputAttachment>) -> Self {
        self.attachments = attachments;
        self
    }

    pub fn with_metadata(mut self, metadata: serde_json::Map<String, serde_json::Value>) -> Self {
        self.metadata = metadata;
        self
    }
}

#[derive(Debug, Clone)]
pub struct AgentRunHandle {
    pub session_id: String,
    pub turn_id: String,
    pub agent_type: Option<String>,
    pub accepted: bool,
    pub events: Option<AgentEventStream>,
}

impl AgentRuntime {
    /// Attach the host-owned Session event projection after a narrow Runtime
    /// facade has been assembled from existing product ports.
    pub fn with_session_event_journal(mut self, journal: Arc<SessionEventJournal>) -> Self {
        self.session_event_journal = Some(journal);
        self
    }

    pub fn subscribe_events(&self) -> Result<AgentEventReceiver, RuntimeError> {
        self.event_source
            .as_ref()
            .map(AgentEventSource::subscribe)
            .ok_or(RuntimeError::MissingEventSource)
    }

    pub fn subscribe_session_events(
        &self,
        session_id: &str,
    ) -> Result<AgentSessionEventReceiver, RuntimeError> {
        self.event_source
            .as_ref()
            .map(|source| source.subscribe_session(session_id))
            .ok_or(RuntimeError::MissingEventSource)
    }

    pub fn pending_permission_requests(&self) -> Result<Vec<PermissionRequest>, RuntimeError> {
        self.permission_requests
            .as_ref()
            .map(|manager| manager.interactive_pending_requests())
            .ok_or(RuntimeError::MissingPermissionRequestManager)
    }

    /// Dismiss only the session-scoped question, including after interaction.
    pub fn cancel_user_question(
        &self,
        session_id: &str,
        tool_id: &str,
    ) -> Result<(), crate::user_questions::UserInputSendError> {
        get_user_input_manager().cancel_for_session(session_id, tool_id)
    }

    /// Stop the unattended deadline in the same owner mailbox used for reattachment.
    pub fn start_user_question_interaction(
        &self,
        session_id: &str,
        tool_id: &str,
    ) -> Result<(), crate::user_questions::UserInputSendError> {
        get_user_input_manager().start_interaction(session_id, tool_id)
    }

    /// Capture every blocking interaction needed to resume rendering one
    /// Session. Push events remain the low-latency path; this snapshot is the
    /// gap-recovery contract for reconnecting or device-switching surfaces.
    pub fn session_interaction_snapshot(&self, session_id: &str) -> SessionInteractionSnapshot {
        let user_questions = get_user_input_manager().pending_question_snapshot(session_id);
        let permissions =
            self.permission_requests
                .as_ref()
                .map(|manager| {
                    let mut snapshot = manager.interactive_pending_snapshot();
                    snapshot.requests.retain(|request| {
                        request.session_id == session_id
                            || request.delegation.as_ref().is_some_and(|delegation| {
                                delegation.parent_session_id == session_id
                            })
                    });
                    snapshot
                })
                .unwrap_or_default();
        SessionInteractionSnapshot {
            session_id: session_id.to_string(),
            user_questions,
            permissions,
        }
    }

    /// Materialized current-Turn projection owned by the Runtime Host.
    ///
    /// Unlike a live receiver, this remains available while no client is
    /// subscribed and is therefore safe for GUI/TUI/Peer reattachment.
    pub fn session_event_projection_snapshot(
        &self,
        session_id: &str,
    ) -> Option<SessionEventProjectionSnapshot> {
        self.session_event_journal
            .as_ref()
            .map(|journal| journal.snapshot(session_id))
    }

    /// Incremental catch-up for a client that already applied up to `cursor`.
    ///
    /// Prefer this over a snapshot when a client detects a delivery gap: it
    /// returns only what was missed, so a live projection is repaired instead
    /// of rebuilt.
    pub fn session_events_since(
        &self,
        session_id: &str,
        stream_id: &str,
        cursor: u64,
    ) -> Option<SessionEventBackfill> {
        self.session_event_journal
            .as_ref()
            .map(|journal| journal.events_since(session_id, stream_id, cursor))
    }

    pub fn permission_request_dialog_turn_id(
        &self,
        request_id: &str,
    ) -> Result<Option<String>, RuntimeError> {
        self.permission_requests
            .as_ref()
            .map(|manager| manager.pending_request_dialog_turn_id(request_id))
            .ok_or(RuntimeError::MissingPermissionRequestManager)
    }

    pub fn subscribe_permission_requests(
        &self,
    ) -> Result<PermissionRequestEventReceiver, RuntimeError> {
        self.permission_requests
            .as_ref()
            .map(|manager| manager.subscribe())
            .ok_or(RuntimeError::MissingPermissionRequestManager)
    }

    pub async fn respond_permission(
        &self,
        request_id: &str,
        reply: PermissionReply,
        source: PermissionReplySource,
    ) -> Result<(), RuntimeError> {
        self.permission_requests
            .as_ref()
            .ok_or(RuntimeError::MissingPermissionRequestManager)?
            .reply(request_id, reply, source)
            .await
            .map(|_| ())
            .map_err(|error| RuntimeError::PermissionRequest(error.to_string()))
    }

    pub async fn respond_permission_batch(
        &self,
        request_id: &str,
        reply: PermissionReply,
        source: PermissionReplySource,
    ) -> Result<Vec<String>, RuntimeError> {
        self.permission_requests
            .as_ref()
            .ok_or(RuntimeError::MissingPermissionRequestManager)?
            .reply_from(request_id, true, reply, source)
            .await
            .map(|resolution| resolution.resolved_request_ids)
            .map_err(|error| RuntimeError::PermissionRequest(error.to_string()))
    }

    pub async fn list_project_permission_grants(
        &self,
        project_id: &str,
    ) -> Result<Vec<PermissionGrant>, RuntimeError> {
        self.permission_requests
            .as_ref()
            .ok_or(RuntimeError::MissingPermissionRequestManager)?
            .list_project_grants(project_id)
            .await
            .map_err(|error| RuntimeError::PermissionRequest(error.to_string()))
    }

    pub async fn remove_project_permission_grant(
        &self,
        key: PermissionGrantKey,
    ) -> Result<bool, RuntimeError> {
        self.permission_requests
            .as_ref()
            .ok_or(RuntimeError::MissingPermissionRequestManager)?
            .remove_project_grant(key)
            .await
            .map_err(|error| RuntimeError::PermissionRequest(error.to_string()))
    }

    pub async fn clear_project_permission_grants(
        &self,
        project_id: &str,
    ) -> Result<usize, RuntimeError> {
        self.permission_requests
            .as_ref()
            .ok_or(RuntimeError::MissingPermissionRequestManager)?
            .clear_project_grants(project_id)
            .await
            .map_err(|error| RuntimeError::PermissionRequest(error.to_string()))
    }

    pub async fn list_project_permission_audit(
        &self,
        project_id: &str,
    ) -> Result<Vec<PermissionAuditRecord>, RuntimeError> {
        self.permission_requests
            .as_ref()
            .ok_or(RuntimeError::MissingPermissionRequestManager)?
            .list_project_permission_audit(project_id)
            .await
            .map_err(|error| RuntimeError::PermissionRequest(error.to_string()))
    }

    pub fn services(&self) -> Option<&RuntimeServices> {
        self.services.as_ref()
    }

    pub async fn workspace_diff(&self) -> Result<WorkspaceDiffSnapshot, RuntimeError> {
        let services = self.services.as_ref().ok_or_else(|| {
            PortError::new(
                PortErrorKind::NotAvailable,
                "runtime services are not registered",
            )
        })?;
        let git = services.git.as_ref().ok_or_else(|| {
            PortError::new(
                PortErrorKind::NotAvailable,
                "Git runtime service is not registered",
            )
        })?;
        git.workspace_diff().await.map_err(RuntimeError::from)
    }

    pub fn registered_tool_names(&self) -> Vec<String> {
        self.tool_registry
            .as_ref()
            .map(|registry| registry.tool_names())
            .unwrap_or_default()
    }

    pub async fn submit_user_answers(
        &self,
        request: AgentUserAnswersRequest,
    ) -> Result<(), RuntimeError> {
        self.interaction_response
            .as_ref()
            .ok_or(RuntimeError::MissingInteractionResponsePort)?
            .submit_user_answers(request)
            .await?;
        Ok(())
    }

    pub fn hook_registry(&self) -> &RuntimeHookRegistry {
        &self.hook_registry
    }

    pub fn plugin_runtime(&self) -> &PluginRuntimeBinding {
        &self.plugin_runtime
    }

    pub fn registered_agent_ids(&self, query: RuntimeAgentRegistryQuery<'_>) -> Vec<String> {
        self.agent_registry
            .as_ref()
            .map(|registry| registry.agent_ids(query))
            .unwrap_or_default()
    }

    pub async fn list_agent_modes(
        &self,
        query: AgentModeCatalogQuery,
    ) -> Result<Vec<AgentModeCatalogEntry>, RuntimeError> {
        self.mode_catalog
            .as_ref()
            .ok_or_else(|| {
                RuntimeError::Port(PortError::new(
                    PortErrorKind::NotAvailable,
                    "agent mode catalog port is not registered",
                ))
            })?
            .list_modes(query)
            .await
            .map_err(RuntimeError::from)
    }

    pub async fn create_session(
        &self,
        request: AgentSessionCreateRequest,
    ) -> Result<AgentSessionCreateResult, RuntimeError> {
        self.submission
            .create_session(request)
            .await
            .map_err(RuntimeError::from)
    }

    pub async fn create_session_with_id(
        &self,
        session_id: String,
        request: AgentSessionCreateRequest,
    ) -> Result<AgentSessionCreateResult, RuntimeError> {
        let result = self
            .submission
            .create_session_with_id(session_id.clone(), request)
            .await
            .map_err(RuntimeError::from)?;
        if result.session_id != session_id {
            return Err(PortError::new(
                PortErrorKind::Backend,
                format!(
                    "agent submission provider returned session_id '{}' for requested session_id '{}'",
                    result.session_id, session_id
                ),
            )
            .into());
        }
        Ok(result)
    }

    pub async fn create_transient_session_with_id(
        &self,
        session_id: String,
        request: AgentSessionCreateRequest,
    ) -> Result<AgentSessionCreateResult, RuntimeError> {
        let result = self
            .submission
            .create_transient_session_with_id(session_id.clone(), request)
            .await
            .map_err(RuntimeError::from)?;
        if result.session_id != session_id {
            return Err(PortError::new(
                PortErrorKind::Backend,
                format!(
                    "agent submission provider returned session_id '{}' for requested transient session_id '{}'",
                    result.session_id, session_id
                ),
            )
            .into());
        }
        Ok(result)
    }

    pub async fn discard_transient_session(
        &self,
        request: AgentTransientSessionDiscardRequest,
    ) -> Result<bool, RuntimeError> {
        self.session_close
            .as_ref()
            .ok_or_else(|| {
                RuntimeError::Port(PortError::new(
                    PortErrorKind::NotAvailable,
                    "agent session close port is not registered",
                ))
            })?
            .discard_transient_session(request)
            .await
            .map_err(RuntimeError::from)
    }

    pub async fn unload_persisted_session(
        &self,
        request: AgentSessionReleaseRequest,
    ) -> Result<bool, RuntimeError> {
        self.session_close
            .as_ref()
            .ok_or_else(|| {
                RuntimeError::Port(PortError::new(
                    PortErrorKind::NotAvailable,
                    "agent session close port is not registered",
                ))
            })?
            .unload_persisted_session(request)
            .await
            .map_err(RuntimeError::from)
    }

    pub async fn list_sessions(
        &self,
        request: AgentSessionListRequest,
    ) -> Result<Vec<AgentSessionSummary>, RuntimeError> {
        let session_management = self
            .session_management
            .as_ref()
            .ok_or(RuntimeError::MissingSessionManagementPort)?;
        session_management
            .list_sessions(request)
            .await
            .map_err(RuntimeError::from)
    }

    pub async fn delete_session(
        &self,
        request: AgentSessionDeleteRequest,
    ) -> Result<(), RuntimeError> {
        let session_management = self
            .session_management
            .as_ref()
            .ok_or(RuntimeError::MissingSessionManagementPort)?;
        session_management
            .delete_session(request)
            .await
            .map_err(RuntimeError::from)
    }

    pub async fn rename_session(
        &self,
        request: AgentSessionRenameRequest,
    ) -> Result<(), RuntimeError> {
        let session_management = self
            .session_management
            .as_ref()
            .ok_or(RuntimeError::MissingSessionManagementPort)?;
        session_management
            .rename_session(request)
            .await
            .map_err(RuntimeError::from)
    }

    pub async fn archive_session(
        &self,
        request: AgentSessionArchiveRequest,
    ) -> Result<(), RuntimeError> {
        let session_management = self
            .session_management
            .as_ref()
            .ok_or(RuntimeError::MissingSessionManagementPort)?;
        session_management
            .archive_session(request)
            .await
            .map_err(RuntimeError::from)
    }

    pub async fn set_session_archived(
        &self,
        request: AgentSessionArchiveStateRequest,
    ) -> Result<(), RuntimeError> {
        let session_management = self
            .session_management
            .as_ref()
            .ok_or(RuntimeError::MissingSessionManagementPort)?;
        session_management
            .set_session_archived(request)
            .await
            .map_err(RuntimeError::from)
    }

    pub async fn record_completed_local_command_turn(
        &self,
        request: AgentLocalCommandTurnRecordRequest,
    ) -> Result<AgentLocalCommandTurnRecordResult, RuntimeError> {
        let port = self
            .local_command_turn
            .as_ref()
            .ok_or(RuntimeError::MissingLocalCommandTurnPort)?;
        port.record_completed_local_command_turn(request)
            .await
            .map_err(RuntimeError::from)
    }

    pub async fn run_user_shell_command(
        &self,
        request: AgentUserShellCommandRequest,
    ) -> Result<AgentUserShellCommandResult, RuntimeError> {
        let requested_session_id = request.session_id.clone();
        let requested_turn_id = request.turn_id.clone();
        let port = self.user_shell_command.as_ref().ok_or_else(|| {
            RuntimeError::Port(PortError::new(
                PortErrorKind::NotAvailable,
                "agent user shell command port is not registered",
            ))
        })?;
        let result = port
            .run_user_shell_command(request)
            .await
            .map_err(RuntimeError::from)?;
        if result.session_id != requested_session_id || result.turn_id != requested_turn_id {
            return Err(PortError::new(
                PortErrorKind::Backend,
                format!(
                    "agent user shell provider returned identity '{}/{}' for requested identity '{}/{}'",
                    result.session_id, result.turn_id, requested_session_id, requested_turn_id
                ),
            )
            .into());
        }
        Ok(result)
    }

    pub async fn update_session_model(
        &self,
        request: AgentSessionModelUpdateRequest,
    ) -> Result<(), RuntimeError> {
        let session_model = self.session_model.as_ref().ok_or_else(|| {
            RuntimeError::Port(PortError::new(
                PortErrorKind::NotAvailable,
                "agent session model port is not registered",
            ))
        })?;
        session_model
            .update_session_model(request)
            .await
            .map_err(RuntimeError::from)
    }

    pub async fn update_session_model_selection(
        &self,
        request: AgentSessionModelSelectionUpdateRequest,
    ) -> Result<(), RuntimeError> {
        let session_model = self.session_model.as_ref().ok_or_else(|| {
            RuntimeError::Port(PortError::new(
                PortErrorKind::NotAvailable,
                "agent session model port is not registered",
            ))
        })?;
        session_model
            .update_session_model_selection(request)
            .await
            .map_err(RuntimeError::from)
    }

    pub async fn update_session_mode(
        &self,
        request: AgentSessionModeUpdateRequest,
    ) -> Result<(), RuntimeError> {
        let session_mode = self.session_mode.as_ref().ok_or_else(|| {
            RuntimeError::Port(PortError::new(
                PortErrorKind::NotAvailable,
                "agent session mode port is not registered",
            ))
        })?;
        session_mode
            .update_session_mode(request)
            .await
            .map_err(RuntimeError::from)
    }

    pub async fn start_session_compaction(
        &self,
        request: AgentSessionCompactionRequest,
    ) -> Result<AgentSessionCompactionResult, RuntimeError> {
        let port = self.session_compaction.as_ref().ok_or_else(|| {
            RuntimeError::Port(PortError::new(
                PortErrorKind::NotAvailable,
                "agent session compaction port is not registered",
            ))
        })?;
        port.start_session_compaction(request)
            .await
            .map_err(RuntimeError::from)
    }

    pub async fn undo_session(
        &self,
        request: AgentSessionRevertRequest,
    ) -> Result<AgentSessionRevertResult, RuntimeError> {
        let port = self.session_revert.as_ref().ok_or_else(|| {
            RuntimeError::Port(PortError::new(
                PortErrorKind::NotAvailable,
                "agent session revert port is not registered",
            ))
        })?;
        port.undo_session(request).await.map_err(RuntimeError::from)
    }

    pub async fn redo_session(
        &self,
        request: AgentSessionRevertRequest,
    ) -> Result<AgentSessionRevertResult, RuntimeError> {
        let port = self.session_revert.as_ref().ok_or_else(|| {
            RuntimeError::Port(PortError::new(
                PortErrorKind::NotAvailable,
                "agent session revert port is not registered",
            ))
        })?;
        port.redo_session(request).await.map_err(RuntimeError::from)
    }

    pub async fn rollback_session_to_turn(
        &self,
        request: AgentSessionRollbackToTurnRequest,
    ) -> Result<AgentSessionRollbackToTurnOutcome, RuntimeError> {
        let port = self.session_revert.as_ref().ok_or_else(|| {
            RuntimeError::Port(PortError::new(
                PortErrorKind::NotAvailable,
                "agent session revert port is not registered",
            ))
        })?;
        port.rollback_session_to_turn(request)
            .await
            .map_err(RuntimeError::from)
    }

    pub async fn fork_session(
        &self,
        request: AgentSessionForkRequest,
    ) -> Result<AgentSessionForkResult, RuntimeError> {
        let port = self.session_fork.as_ref().ok_or_else(|| {
            RuntimeError::Port(PortError::new(
                PortErrorKind::NotAvailable,
                "agent session fork port is not registered",
            ))
        })?;
        port.fork_session(request).await.map_err(RuntimeError::from)
    }

    pub async fn fork_session_at_turn(
        &self,
        request: AgentSessionForkAtTurnRequest,
    ) -> Result<AgentSessionForkResult, RuntimeError> {
        let port = self.session_fork.as_ref().ok_or_else(|| {
            RuntimeError::Port(PortError::new(
                PortErrorKind::NotAvailable,
                "agent session fork port is not registered",
            ))
        })?;
        port.fork_session_at_turn(request)
            .await
            .map_err(RuntimeError::from)
    }

    pub async fn fork_session_before_turn(
        &self,
        request: AgentSessionForkBeforeTurnRequest,
    ) -> Result<AgentSessionForkResult, RuntimeError> {
        let port = self.session_fork.as_ref().ok_or_else(|| {
            RuntimeError::Port(PortError::new(
                PortErrorKind::NotAvailable,
                "agent session fork port is not registered",
            ))
        })?;
        port.fork_session_before_turn(request)
            .await
            .map_err(RuntimeError::from)
    }

    pub async fn generate_session_usage(
        &self,
        request: AgentSessionUsageRequest,
    ) -> Result<openbitfun_core_types::SessionUsageReport, RuntimeError> {
        let port = self.session_usage.as_ref().ok_or_else(|| {
            RuntimeError::Port(PortError::new(
                PortErrorKind::NotAvailable,
                "agent session usage port is not registered",
            ))
        })?;
        port.generate_session_usage(request)
            .await
            .map_err(RuntimeError::from)
    }

    pub async fn wait_for_turn_settlement(
        &self,
        request: AgentTurnSettlementRequest,
    ) -> Result<AgentTurnSettlementResult, RuntimeError> {
        let port = self.turn_settlement.as_ref().ok_or_else(|| {
            RuntimeError::Port(PortError::new(
                PortErrorKind::NotAvailable,
                "agent turn settlement port is not registered",
            ))
        })?;
        port.wait_for_turn_settlement(request)
            .await
            .map_err(RuntimeError::from)
    }

    pub async fn restore_session(
        &self,
        request: AgentSessionRestoreRequest,
    ) -> Result<AgentSessionRestoreResult, RuntimeError> {
        let session_restore = self
            .session_restore
            .as_ref()
            .ok_or(RuntimeError::MissingSessionRestorePort)?;
        session_restore
            .restore_session(request)
            .await
            .map_err(RuntimeError::from)
    }

    pub async fn read_session_transcript(
        &self,
        request: SessionTranscriptRequest,
    ) -> Result<SessionTranscript, RuntimeError> {
        let reader = self
            .session_transcript_reader
            .as_ref()
            .ok_or(RuntimeError::MissingSessionTranscriptReader)?;
        reader
            .read_session_transcript(request)
            .await
            .map_err(RuntimeError::from)
    }

    pub async fn get_session_lineage(
        &self,
        request: AgentSessionLineageRequest,
    ) -> Result<Option<AgentSessionLineageSnapshot>, RuntimeError> {
        let lineage = self
            .session_lineage
            .as_ref()
            .ok_or(RuntimeError::MissingSessionLineagePort)?;
        lineage
            .get_session_lineage(request)
            .await
            .map_err(RuntimeError::from)
    }

    pub async fn read_lineage_session_transcript(
        &self,
        request: AgentSessionLineageTranscriptRequest,
    ) -> Result<AgentSessionLineageInspection, RuntimeError> {
        let lineage = self
            .session_lineage
            .as_ref()
            .ok_or(RuntimeError::MissingSessionLineagePort)?;
        lineage
            .read_lineage_session_transcript(request)
            .await
            .map_err(RuntimeError::from)
    }

    pub async fn resolve_session_workspace_binding(
        &self,
        request: AgentSessionWorkspaceRequest,
    ) -> Result<Option<AgentSessionWorkspaceBinding>, RuntimeError> {
        let session_management = self
            .session_management
            .as_ref()
            .ok_or(RuntimeError::MissingSessionManagementPort)?;
        session_management
            .resolve_session_workspace_binding(request)
            .await
            .map_err(RuntimeError::from)
    }

    pub async fn search_workspace_references(
        &self,
        request: AgentWorkspaceReferenceSearchRequest,
    ) -> Result<AgentWorkspaceReferenceSearchResult, RuntimeError> {
        self.workspace_references
            .as_ref()
            .ok_or(RuntimeError::MissingWorkspaceReferencePort)?
            .search_workspace_references(request)
            .await
            .map_err(RuntimeError::from)
    }

    pub async fn workspace_references_for_message(
        &self,
        request: AgentMessageWorkspaceReferencesRequest,
    ) -> Result<Vec<AgentWorkspaceReference>, RuntimeError> {
        self.workspace_references
            .as_ref()
            .ok_or(RuntimeError::MissingWorkspaceReferencePort)?
            .workspace_references_for_message(request)
            .await
            .map_err(RuntimeError::from)
    }

    pub async fn submit_turn(
        &self,
        request: AgentSubmissionRequest,
    ) -> Result<AgentSubmissionResult, RuntimeError> {
        self.submission
            .submit_message(request)
            .await
            .map_err(RuntimeError::from)
    }

    pub async fn submit_dialog_turn(
        &self,
        request: AgentDialogTurnRequest,
    ) -> Result<DialogSubmitOutcome, RuntimeError> {
        let requested_session_id = request.session_id.clone();
        let dialog_turn = self
            .dialog_turn
            .as_ref()
            .ok_or(RuntimeError::MissingDialogTurnPort)?;
        let outcome = dialog_turn
            .submit_dialog_turn(request)
            .await
            .map_err(RuntimeError::from)?;
        let returned_session_id = match &outcome {
            DialogSubmitOutcome::Started { session_id, .. }
            | DialogSubmitOutcome::Queued { session_id, .. } => session_id,
        };
        if returned_session_id != &requested_session_id {
            return Err(PortError::new(
                PortErrorKind::Backend,
                format!(
                    "agent dialog provider returned session_id '{}' for requested session_id '{}'",
                    returned_session_id, requested_session_id
                ),
            )
            .into());
        }
        Ok(outcome)
    }

    pub async fn steer_dialog_turn(
        &self,
        request: AgentDialogSteerRequest,
    ) -> Result<DialogSteerOutcome, RuntimeError> {
        let requested_session_id = request.session_id.clone();
        let requested_turn_id = request.turn_id.clone();
        let dialog_turn = self
            .dialog_turn
            .as_ref()
            .ok_or(RuntimeError::MissingDialogTurnPort)?;
        let outcome = dialog_turn
            .steer_dialog_turn(request)
            .await
            .map_err(RuntimeError::from)?;
        let DialogSteerOutcome::Buffered {
            session_id,
            turn_id,
            ..
        } = &outcome;
        if session_id != &requested_session_id || turn_id != &requested_turn_id {
            return Err(PortError::new(
                PortErrorKind::Backend,
                format!(
                    "agent dialog provider returned session_id '{}' and turn_id '{}' for requested session_id '{}' and turn_id '{}'",
                    session_id, turn_id, requested_session_id, requested_turn_id
                ),
            )
            .into());
        }
        Ok(outcome)
    }

    pub async fn recover_interrupted_turn(
        &self,
        request: AgentDialogTurnRecoveryRequest,
    ) -> Result<AgentDialogTurnRecoveryOutcome, RuntimeError> {
        let requested_session_id = request.session_id.clone();
        let requested_turn_id = request.turn_id.clone();
        let dialog_turn = self
            .dialog_turn
            .as_ref()
            .ok_or(RuntimeError::MissingDialogTurnPort)?;
        let outcome = dialog_turn
            .recover_interrupted_turn(request)
            .await
            .map_err(RuntimeError::from)?;
        if outcome.session_id != requested_session_id || outcome.turn_id != requested_turn_id {
            return Err(PortError::new(
                PortErrorKind::Backend,
                format!(
                    "agent dialog recovery provider returned session_id '{}' and turn_id '{}' for requested session_id '{}' and turn_id '{}'",
                    outcome.session_id, outcome.turn_id, requested_session_id, requested_turn_id
                ),
            )
            .into());
        }
        Ok(outcome)
    }

    pub async fn deliver_background_result(
        &self,
        request: AgentBackgroundResultRequest,
    ) -> Result<(), RuntimeError> {
        let lifecycle_delivery = self
            .lifecycle_delivery
            .as_ref()
            .ok_or(RuntimeError::MissingLifecycleDeliveryPort)?;
        lifecycle_delivery
            .deliver_background_result(request)
            .await
            .map_err(RuntimeError::from)
    }

    pub async fn deliver_thread_goal(
        &self,
        request: AgentThreadGoalDeliveryRequest,
    ) -> Result<(), RuntimeError> {
        let lifecycle_delivery = self
            .lifecycle_delivery
            .as_ref()
            .ok_or(RuntimeError::MissingLifecycleDeliveryPort)?;
        lifecycle_delivery
            .deliver_thread_goal(request)
            .await
            .map_err(RuntimeError::from)
    }

    pub async fn get_thread_goal(
        &self,
        request: AgentThreadGoalGetRequest,
    ) -> Result<Option<ThreadGoal>, RuntimeError> {
        let thread_goal_management = self
            .thread_goal_management
            .as_ref()
            .ok_or(RuntimeError::MissingThreadGoalManagementPort)?;
        thread_goal_management
            .get_thread_goal(request)
            .await
            .map_err(RuntimeError::from)
    }

    pub async fn create_thread_goal(
        &self,
        request: AgentThreadGoalCreateRequest,
    ) -> Result<ThreadGoal, RuntimeError> {
        let thread_goal_management = self
            .thread_goal_management
            .as_ref()
            .ok_or(RuntimeError::MissingThreadGoalManagementPort)?;
        thread_goal_management
            .create_thread_goal(request)
            .await
            .map_err(RuntimeError::from)
    }

    pub async fn update_thread_goal_status(
        &self,
        request: AgentThreadGoalUpdateStatusRequest,
    ) -> Result<ThreadGoal, RuntimeError> {
        let thread_goal_management = self
            .thread_goal_management
            .as_ref()
            .ok_or(RuntimeError::MissingThreadGoalManagementPort)?;
        thread_goal_management
            .update_thread_goal_status(request)
            .await
            .map_err(RuntimeError::from)
    }

    pub async fn resolve_session_agent_type(
        &self,
        session_id: &str,
    ) -> Result<Option<String>, RuntimeError> {
        self.submission
            .resolve_session_agent_type(session_id)
            .await
            .map_err(RuntimeError::from)
    }

    pub async fn cancel_turn(
        &self,
        request: AgentTurnCancellationRequest,
    ) -> Result<AgentTurnCancellationResult, RuntimeError> {
        let cancellation = self
            .cancellation
            .as_ref()
            .ok_or(RuntimeError::MissingCancellationPort)?;
        cancellation
            .cancel_turn(request)
            .await
            .map_err(RuntimeError::from)
    }

    pub async fn interrupt_turn(
        &self,
        request: AgentTurnInterruptionRequest,
    ) -> Result<AgentTurnInterruptionResult, RuntimeError> {
        let cancellation = self
            .cancellation
            .as_ref()
            .ok_or(RuntimeError::MissingCancellationPort)?;
        cancellation
            .interrupt_turn(request)
            .await
            .map_err(RuntimeError::from)
    }

    /// Cancels one inspected descendant through the authoritative lineage
    /// owner, which keeps workspace binding and membership validation adjacent
    /// to the existing cancellation execution owner.
    pub async fn cancel_lineage_session(
        &self,
        request: AgentSessionLineageCancellationRequest,
    ) -> Result<AgentTurnCancellationResult, RuntimeError> {
        let lineage = self
            .session_lineage
            .as_ref()
            .ok_or(RuntimeError::MissingSessionLineagePort)?;
        lineage
            .cancel_lineage_session(request)
            .await
            .map_err(RuntimeError::from)
    }

    pub async fn publish_event(&self, event: RuntimeEventEnvelope) -> Result<(), RuntimeError> {
        if self.services.is_none() && self.event_stream.is_none() {
            return Err(RuntimeError::MissingEventSink);
        }

        if let Some(services) = self.services.as_ref() {
            services
                .events
                .publish_runtime_event(event.clone())
                .await
                .map_err(RuntimeError::from)?;
        }
        if let Some(events) = self.event_stream.as_ref() {
            events.push(event);
        }
        Ok(())
    }

    pub async fn run(&self, request: AgentRunRequest) -> Result<AgentRunHandle, RuntimeError> {
        let (session_id, agent_type) = match request.session {
            SessionSelector::Existing { session_id } => {
                let agent_type = self.resolve_session_agent_type(&session_id).await?;
                (session_id, agent_type)
            }
            SessionSelector::Create {
                session_name,
                agent_type,
                workspace_id,
                workspace_path,
                metadata,
            } => {
                let created = self
                    .create_session(AgentSessionCreateRequest {
                        session_name,
                        agent_type,
                        agent_route_key: None,
                        workspace_path,
                        project_workspace_path: None,
                        execution_target: None,
                        workspace_id,
                        remote_connection_id: None,
                        remote_ssh_host: None,
                        model_id: None,
                        metadata,
                    })
                    .await?;
                let agent_type = created.agent_type;
                (created.session_id, Some(agent_type))
            }
        };

        let submitted = self
            .submit_turn(AgentSubmissionRequest {
                session_id: session_id.clone(),
                message: request.message,
                turn_id: request.turn_id,
                source: request.source,
                attachments: request.attachments,
                metadata: request.metadata,
            })
            .await?;

        Ok(AgentRunHandle {
            session_id,
            turn_id: submitted.turn_id,
            agent_type,
            accepted: submitted.accepted,
            events: self.event_stream.clone(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_state::SessionState;
    use openbitfun_runtime_ports::{
        AgentBackgroundResultRequest, AgentDialogTurnRequest, AgentLifecycleDeliveryPort,
        AgentSessionCompactionPort, AgentSessionCompactionRequest, AgentSessionCompactionResult,
        AgentSessionCreateResult, AgentSessionDeleteRequest, AgentSessionLifecycleStatus,
        AgentSessionLineageCancellationRequest, AgentSessionLineageEntry, AgentSessionLineagePort,
        AgentSessionLineageRequest, AgentSessionLineageSnapshot,
        AgentSessionLineageTranscriptRequest, AgentSessionListRequest, AgentSessionManagementPort,
        AgentSessionModePort, AgentSessionModeUpdateRequest, AgentSessionRevertPort,
        AgentSessionRevertRequest, AgentSessionRevertResult, AgentSessionSummary,
        AgentSessionWorkspaceRequest, AgentSubmissionResult, AgentThreadGoalDeliveryKind,
        AgentThreadGoalDeliveryRequest, AgentThreadGoalManagementPort, AgentTurnCancellationResult,
        AgentUserShellCommandPort, AgentUserShellCommandRequest, AgentUserShellCommandResult,
        ClockPort, DialogQueuePriority, DialogSubmissionPolicy, DialogSubmitOutcome,
        FileSystemPort, PluginDispatchEnvelope, PluginResponseEnvelope, PluginRuntimeAvailability,
        PluginRuntimeClient, PluginRuntimeUnavailableReason, PortErrorKind, PortResult,
        RuntimeEventSink, RuntimeEventType, RuntimeServiceCapability, RuntimeServicePort,
        SessionStorageKind, SessionStoragePathRequest, SessionStoragePathResolution,
        SessionStorePort, SessionTranscript, SessionTranscriptReader, SessionTranscriptRequest,
        ThreadGoal, ThreadGoalStatus, TranscriptContent, TranscriptMessage, WorkspacePort,
    };
    use openbitfun_runtime_services::RuntimeServicesBuilder;

    #[test]
    fn session_interaction_snapshot_wire_is_additive_and_camel_case() {
        let legacy: SessionInteractionSnapshot = serde_json::from_value(serde_json::json!({
            "sessionId": "session-1"
        }))
        .expect("older payloads may omit additive mailbox fields");
        assert!(legacy.user_questions.questions.is_empty());
        assert!(legacy.permissions.requests.is_empty());

        let encoded = serde_json::to_value(SessionInteractionSnapshot {
            session_id: "session-1".to_string(),
            user_questions: PendingUserQuestionSnapshot {
                revision: 4,
                questions: Vec::new(),
            },
            permissions: PermissionRequestSnapshot {
                revision: 7,
                requests: Vec::new(),
            },
        })
        .expect("interaction snapshot should serialize");
        assert_eq!(encoded["sessionId"], "session-1");
        assert_eq!(encoded["userQuestions"]["revision"], 4);
        assert_eq!(encoded["permissions"]["revision"], 7);
        assert!(encoded.get("user_questions").is_none());
    }

    #[derive(Debug)]
    struct TestRuntimePort {
        capability: RuntimeServiceCapability,
    }

    impl TestRuntimePort {
        fn new(capability: RuntimeServiceCapability) -> Self {
            Self { capability }
        }
    }

    impl RuntimeServicePort for TestRuntimePort {
        fn capability(&self) -> RuntimeServiceCapability {
            self.capability
        }
    }

    impl FileSystemPort for TestRuntimePort {}
    impl WorkspacePort for TestRuntimePort {}

    #[async_trait::async_trait]
    impl SessionStorePort for TestRuntimePort {
        async fn resolve_session_storage_path(
            &self,
            request: SessionStoragePathRequest,
        ) -> PortResult<SessionStoragePathResolution> {
            Ok(SessionStoragePathResolution::new(
                request.workspace_path.clone(),
                request.workspace_path,
                SessionStorageKind::Local,
                request.remote_connection_id,
                request.remote_ssh_host,
            ))
        }
    }

    impl ClockPort for TestRuntimePort {
        fn now_unix_millis(&self) -> i64 {
            0
        }
    }

    #[derive(Debug, Default)]
    struct FakeAgentRuntimePorts {
        created_sessions: Mutex<Vec<AgentSessionCreateRequest>>,
        exact_session_result_id: Mutex<Option<String>>,
        submitted_messages: Mutex<Vec<AgentSubmissionRequest>>,
        cancelled_turns: Mutex<Vec<AgentTurnCancellationRequest>>,
        interrupted_turns: Mutex<Vec<AgentTurnInterruptionRequest>>,
        compaction_requests: Mutex<Vec<AgentSessionCompactionRequest>>,
        before_turn_fork_requests: Mutex<Vec<AgentSessionForkBeforeTurnRequest>>,
        listed_sessions: Mutex<Vec<AgentSessionListRequest>>,
        deleted_sessions: Mutex<Vec<AgentSessionDeleteRequest>>,
        renamed_sessions: Mutex<Vec<AgentSessionRenameRequest>>,
        archived_sessions: Mutex<Vec<AgentSessionArchiveRequest>>,
        archive_state_updates: Mutex<Vec<AgentSessionArchiveStateRequest>>,
        local_command_turns: Mutex<Vec<AgentLocalCommandTurnRecordRequest>>,
        user_shell_commands: Mutex<Vec<AgentUserShellCommandRequest>>,
        restored_sessions: Mutex<Vec<AgentSessionRestoreRequest>>,
        mode_updates: Mutex<Vec<AgentSessionModeUpdateRequest>>,
        undo_requests: Mutex<Vec<AgentSessionRevertRequest>>,
        transcript_requests: Mutex<Vec<SessionTranscriptRequest>>,
        lineage_requests: Mutex<Vec<AgentSessionLineageRequest>>,
        lineage_transcript_requests: Mutex<Vec<AgentSessionLineageTranscriptRequest>>,
        workspace_binding_requests: Mutex<Vec<AgentSessionWorkspaceRequest>>,
        thread_goal_gets: Mutex<Vec<AgentThreadGoalGetRequest>>,
        thread_goal_creates: Mutex<Vec<AgentThreadGoalCreateRequest>>,
        thread_goal_updates: Mutex<Vec<AgentThreadGoalUpdateStatusRequest>>,
        resolved_agent_type: Option<String>,
    }

    struct MisreportedPluginRuntimeClient;

    #[async_trait::async_trait]
    impl PluginRuntimeClient for MisreportedPluginRuntimeClient {
        fn availability(&self) -> PluginRuntimeAvailability {
            PluginRuntimeAvailability::ProjectionOnly {
                reason: PluginRuntimeUnavailableReason::NotBuilt,
            }
        }

        async fn dispatch(
            &self,
            envelope: PluginDispatchEnvelope,
        ) -> PortResult<PluginResponseEnvelope> {
            Ok(PluginResponseEnvelope {
                envelope_version: envelope.envelope_version,
                request_event_id: envelope.event_id,
                project_domain_id: envelope.project_domain_id,
                workspace_id: envelope.workspace_id,
                adapter_id: "test-plugin-runtime".to_string(),
                plugin_id: Some(envelope.source.plugin_id),
                completed_at_ms: 0,
                effects: Vec::new(),
                diagnostics: Vec::new(),
                quarantine: None,
                plugin_statuses: Vec::new(),
                observed_epochs: envelope.epochs,
            })
        }
    }

    struct AvailablePluginRuntimeClient;

    #[async_trait::async_trait]
    impl PluginRuntimeClient for AvailablePluginRuntimeClient {
        fn availability(&self) -> PluginRuntimeAvailability {
            PluginRuntimeAvailability::Available
        }

        async fn dispatch(
            &self,
            envelope: PluginDispatchEnvelope,
        ) -> PortResult<PluginResponseEnvelope> {
            Ok(PluginResponseEnvelope {
                envelope_version: envelope.envelope_version,
                request_event_id: envelope.event_id,
                project_domain_id: envelope.project_domain_id,
                workspace_id: envelope.workspace_id,
                adapter_id: "test-plugin-runtime".to_string(),
                plugin_id: Some(envelope.source.plugin_id),
                completed_at_ms: 0,
                effects: Vec::new(),
                diagnostics: Vec::new(),
                quarantine: None,
                plugin_statuses: Vec::new(),
                observed_epochs: envelope.epochs,
            })
        }
    }

    fn fake_thread_goal(status: ThreadGoalStatus) -> ThreadGoal {
        ThreadGoal {
            goal_id: "goal_1".to_string(),
            session_id: "session_1".to_string(),
            objective: "Ship runtime port".to_string(),
            status,
            token_budget: Some(1000),
            tokens_used: 10,
            time_used_seconds: 5,
            created_at: 1,
            updated_at: 2,
            auto_continuation_count: 0,
        }
    }

    #[async_trait::async_trait]
    impl AgentSessionManagementPort for FakeAgentRuntimePorts {
        async fn list_sessions(
            &self,
            request: AgentSessionListRequest,
        ) -> PortResult<Vec<AgentSessionSummary>> {
            self.listed_sessions.lock().unwrap().push(request.clone());
            Ok(vec![AgentSessionSummary {
                session_id: "session_1".to_string(),
                session_name: "Main".to_string(),
                agent_type: "Standard".to_string(),
                model_id: None,
                reasoning_preset: None,
                last_user_dialog_agent_type: None,
                last_submitted_agent_type: None,
                turn_count: 3,
                created_at_ms: 1000,
                last_active_at_ms: 2000,
            }])
        }

        async fn delete_session(&self, request: AgentSessionDeleteRequest) -> PortResult<()> {
            self.deleted_sessions.lock().unwrap().push(request);
            Ok(())
        }

        async fn rename_session(&self, request: AgentSessionRenameRequest) -> PortResult<()> {
            self.renamed_sessions.lock().unwrap().push(request);
            Ok(())
        }

        async fn archive_session(&self, request: AgentSessionArchiveRequest) -> PortResult<()> {
            self.archived_sessions.lock().unwrap().push(request);
            Ok(())
        }

        async fn set_session_archived(
            &self,
            request: AgentSessionArchiveStateRequest,
        ) -> PortResult<()> {
            self.archive_state_updates.lock().unwrap().push(request);
            Ok(())
        }

        async fn resolve_session_workspace_binding(
            &self,
            request: AgentSessionWorkspaceRequest,
        ) -> PortResult<Option<AgentSessionWorkspaceBinding>> {
            self.workspace_binding_requests
                .lock()
                .unwrap()
                .push(request);
            Ok(Some(AgentSessionWorkspaceBinding {
                workspace_kind: None,
                project_workspace_id: None,
                workspace_id: Some("workspace_1".to_string()),
                workspace_path: "/workspace/project".to_string(),
                project_workspace_path: None,
                execution_target: None,
                remote_connection_id: Some("conn-1".to_string()),
                remote_ssh_host: Some("host-1".to_string()),
            }))
        }
    }

    #[async_trait::async_trait]
    impl AgentSessionCompactionPort for FakeAgentRuntimePorts {
        async fn start_session_compaction(
            &self,
            request: AgentSessionCompactionRequest,
        ) -> PortResult<AgentSessionCompactionResult> {
            self.compaction_requests
                .lock()
                .unwrap()
                .push(request.clone());
            Ok(AgentSessionCompactionResult {
                session_id: request.session_id,
                turn_id: request.turn_id,
            })
        }
    }

    #[async_trait::async_trait]
    impl AgentSessionForkPort for FakeAgentRuntimePorts {
        async fn fork_session(
            &self,
            request: AgentSessionForkRequest,
        ) -> PortResult<AgentSessionForkResult> {
            Ok(AgentSessionForkResult {
                session_id: format!("{}-fork", request.source_session_id),
                session_name: "Forked session".to_string(),
                agent_type: "Standard".to_string(),
            })
        }

        async fn fork_session_before_turn(
            &self,
            request: AgentSessionForkBeforeTurnRequest,
        ) -> PortResult<AgentSessionForkResult> {
            self.before_turn_fork_requests.lock().unwrap().push(request);
            Ok(AgentSessionForkResult {
                session_id: "session-fork".to_string(),
                session_name: "Forked session".to_string(),
                agent_type: "Standard".to_string(),
            })
        }
    }

    #[async_trait::async_trait]
    impl AgentSessionRevertPort for FakeAgentRuntimePorts {
        async fn undo_session(
            &self,
            request: AgentSessionRevertRequest,
        ) -> PortResult<AgentSessionRevertResult> {
            self.undo_requests.lock().unwrap().push(request.clone());
            Ok(AgentSessionRevertResult {
                session_id: request.session_id.clone(),
                transcript: SessionTranscript {
                    session_id: request.session_id,
                    messages: Vec::new(),
                },
                composer: openbitfun_runtime_ports::AgentSessionComposerUpdate::Preserve,
                retired_turn_ids: Vec::new(),
                changed: true,
                hidden_turn_count: 1,
                boundary_storage_turn_index: None,
                target_turn_id: None,
                restored_files: Vec::new(),
                reload_required: false,
                reload_reason: None,
            })
        }

        async fn redo_session(
            &self,
            request: AgentSessionRevertRequest,
        ) -> PortResult<AgentSessionRevertResult> {
            self.undo_session(request).await
        }
    }

    #[async_trait::async_trait]
    impl AgentLocalCommandTurnPort for FakeAgentRuntimePorts {
        async fn record_completed_local_command_turn(
            &self,
            request: AgentLocalCommandTurnRecordRequest,
        ) -> PortResult<AgentLocalCommandTurnRecordResult> {
            let mut turns = self.local_command_turns.lock().unwrap();
            let storage_turn_index = turns.len();
            let turn_id = request
                .turn_id
                .clone()
                .unwrap_or_else(|| format!("local-command-{storage_turn_index}"));
            turns.push(request);
            Ok(AgentLocalCommandTurnRecordResult {
                turn_id,
                storage_turn_index,
            })
        }
    }

    #[async_trait::async_trait]
    impl AgentUserShellCommandPort for FakeAgentRuntimePorts {
        async fn run_user_shell_command(
            &self,
            request: AgentUserShellCommandRequest,
        ) -> PortResult<AgentUserShellCommandResult> {
            self.user_shell_commands
                .lock()
                .unwrap()
                .push(request.clone());
            Ok(AgentUserShellCommandResult {
                session_id: request.session_id,
                turn_id: request.turn_id,
            })
        }
    }

    #[async_trait::async_trait]
    impl AgentSessionRestorePort for FakeAgentRuntimePorts {
        async fn restore_session(
            &self,
            request: AgentSessionRestoreRequest,
        ) -> PortResult<AgentSessionRestoreResult> {
            self.restored_sessions.lock().unwrap().push(request);
            Ok(AgentSessionRestoreResult {
                session: AgentSessionSummary {
                    session_id: "session_1".to_string(),
                    session_name: "Main".to_string(),
                    agent_type: "Standard".to_string(),
                    model_id: Some("provider/model".to_string()),
                    reasoning_preset: Some("high".to_string()),
                    last_user_dialog_agent_type: Some("plan".to_string()),
                    last_submitted_agent_type: Some("Standard".to_string()),
                    turn_count: 3,
                    created_at_ms: 1000,
                    last_active_at_ms: 2000,
                },
                state: SessionState::Idle,
            })
        }
    }

    #[async_trait::async_trait]
    impl AgentSessionModePort for FakeAgentRuntimePorts {
        async fn update_session_mode(
            &self,
            request: AgentSessionModeUpdateRequest,
        ) -> PortResult<()> {
            self.mode_updates.lock().unwrap().push(request);
            Ok(())
        }
    }

    #[async_trait::async_trait]
    impl SessionTranscriptReader for FakeAgentRuntimePorts {
        async fn read_session_transcript(
            &self,
            request: SessionTranscriptRequest,
        ) -> PortResult<SessionTranscript> {
            self.transcript_requests
                .lock()
                .unwrap()
                .push(request.clone());
            Ok(SessionTranscript {
                session_id: request.session_id,
                messages: vec![TranscriptMessage {
                    id: Some("message_1".to_string()),
                    role: "assistant".to_string(),
                    turn_id: request.turn_id,
                    timestamp_ms: Some(1000),
                    content: TranscriptContent::Text("done".to_string()),
                }],
            })
        }
    }

    #[async_trait::async_trait]
    impl AgentSessionLineagePort for FakeAgentRuntimePorts {
        async fn get_session_lineage(
            &self,
            request: AgentSessionLineageRequest,
        ) -> PortResult<Option<AgentSessionLineageSnapshot>> {
            self.lineage_requests.lock().unwrap().push(request);
            Ok(Some(AgentSessionLineageSnapshot {
                root_session_id: "root_1".to_string(),
                sessions: vec![
                    AgentSessionLineageEntry {
                        session_id: "root_1".to_string(),
                        session_name: "Root".to_string(),
                        agent_type: "Standard".to_string(),
                        created_at_ms: 1,
                        status: AgentSessionLifecycleStatus::Active,
                        active_turn_id: None,
                        parent_session_id: None,
                        parent_tool_call_id: None,
                        subagent_type: None,
                        agent_id: None,
                        workspace_id: Some("workspace-project".to_string()),
                        workspace_path: Some("/workspace/project".to_string()),
                        remote_connection_id: None,
                        remote_ssh_host: None,
                        unread_completion: None,
                        needs_user_attention: None,
                    },
                    AgentSessionLineageEntry {
                        session_id: "child_1".to_string(),
                        session_name: "Child".to_string(),
                        agent_type: "explore".to_string(),
                        created_at_ms: 3,
                        status: AgentSessionLifecycleStatus::Completed,
                        active_turn_id: None,
                        parent_session_id: Some("root_1".to_string()),
                        parent_tool_call_id: Some("tool_1".to_string()),
                        subagent_type: Some("explore".to_string()),
                        agent_id: Some("child-agent".to_string()),
                        workspace_id: Some("workspace-project".to_string()),
                        workspace_path: Some("/workspace/project".to_string()),
                        remote_connection_id: None,
                        remote_ssh_host: None,
                        unread_completion: Some("completed".to_string()),
                        needs_user_attention: None,
                    },
                ],
            }))
        }

        async fn read_lineage_session_transcript(
            &self,
            request: AgentSessionLineageTranscriptRequest,
        ) -> PortResult<AgentSessionLineageInspection> {
            self.lineage_transcript_requests
                .lock()
                .unwrap()
                .push(request.clone());
            Ok(AgentSessionLineageInspection {
                transcript: SessionTranscript {
                    session_id: request.session_id,
                    messages: vec![TranscriptMessage {
                        id: Some("child_message".to_string()),
                        role: "assistant".to_string(),
                        turn_id: Some("child_turn".to_string()),
                        timestamp_ms: Some(5),
                        content: TranscriptContent::Text("child result".to_string()),
                    }],
                },
                active_turn_id: Some("child_turn".to_string()),
            })
        }

        async fn cancel_lineage_session(
            &self,
            request: AgentSessionLineageCancellationRequest,
        ) -> PortResult<AgentTurnCancellationResult> {
            if request.root_session_id != "root_1"
                || request.session_id == request.root_session_id
                || request.session_id != "child_1"
            {
                return Err(PortError::new(
                    PortErrorKind::InvalidRequest,
                    "lineage cancellation target is not a descendant of the requested root",
                ));
            }
            AgentTurnCancellationPort::cancel_turn(
                self,
                AgentTurnCancellationRequest {
                    session_id: request.session_id,
                    turn_id: request.expected_active_turn_id,
                    source: request.source,
                    requester_session_id: None,
                    reason: request.reason,
                    wait_timeout_ms: request.wait_timeout_ms,
                    cancel_descendants: true,
                },
            )
            .await
        }
    }

    #[async_trait::async_trait]
    impl AgentSubmissionPort for FakeAgentRuntimePorts {
        async fn create_session(
            &self,
            request: AgentSessionCreateRequest,
        ) -> PortResult<AgentSessionCreateResult> {
            self.created_sessions.lock().unwrap().push(request.clone());
            Ok(AgentSessionCreateResult::new(
                "session_1",
                request.session_name,
                request.agent_type,
            ))
        }

        async fn create_session_with_id(
            &self,
            session_id: String,
            request: AgentSessionCreateRequest,
        ) -> PortResult<AgentSessionCreateResult> {
            self.created_sessions.lock().unwrap().push(request.clone());
            Ok(AgentSessionCreateResult::new(
                self.exact_session_result_id
                    .lock()
                    .unwrap()
                    .clone()
                    .unwrap_or(session_id),
                request.session_name,
                request.agent_type,
            ))
        }

        async fn submit_message(
            &self,
            request: AgentSubmissionRequest,
        ) -> PortResult<AgentSubmissionResult> {
            self.submitted_messages
                .lock()
                .unwrap()
                .push(request.clone());
            Ok(AgentSubmissionResult {
                turn_id: request
                    .turn_id
                    .unwrap_or_else(|| "generated_turn".to_string()),
                accepted: true,
            })
        }

        async fn resolve_session_agent_type(
            &self,
            _session_id: &str,
        ) -> PortResult<Option<String>> {
            Ok(self.resolved_agent_type.clone())
        }
    }

    #[async_trait::async_trait]
    impl AgentThreadGoalManagementPort for FakeAgentRuntimePorts {
        async fn get_thread_goal(
            &self,
            request: AgentThreadGoalGetRequest,
        ) -> PortResult<Option<ThreadGoal>> {
            self.thread_goal_gets.lock().unwrap().push(request);
            Ok(Some(fake_thread_goal(ThreadGoalStatus::Active)))
        }

        async fn create_thread_goal(
            &self,
            request: AgentThreadGoalCreateRequest,
        ) -> PortResult<ThreadGoal> {
            self.thread_goal_creates.lock().unwrap().push(request);
            Ok(fake_thread_goal(ThreadGoalStatus::Active))
        }

        async fn update_thread_goal_status(
            &self,
            request: AgentThreadGoalUpdateStatusRequest,
        ) -> PortResult<ThreadGoal> {
            let status = request.status;
            self.thread_goal_updates.lock().unwrap().push(request);
            Ok(fake_thread_goal(status))
        }
    }

    #[async_trait::async_trait]
    impl AgentTurnCancellationPort for FakeAgentRuntimePorts {
        async fn cancel_turn(
            &self,
            request: AgentTurnCancellationRequest,
        ) -> PortResult<AgentTurnCancellationResult> {
            self.cancelled_turns.lock().unwrap().push(request.clone());
            Ok(AgentTurnCancellationResult {
                session_id: request.session_id,
                turn_id: request.turn_id,
                requested: true,
            })
        }

        async fn interrupt_turn(
            &self,
            request: AgentTurnInterruptionRequest,
        ) -> PortResult<AgentTurnInterruptionResult> {
            self.interrupted_turns.lock().unwrap().push(request.clone());
            Ok(AgentTurnInterruptionResult {
                session_id: request.session_id,
                turn_id: request.turn_id,
                requested: true,
            })
        }
    }

    #[derive(Debug, Default)]
    struct RecordingRuntimeEventSink {
        events: Mutex<Vec<RuntimeEventEnvelope>>,
    }

    impl RecordingRuntimeEventSink {
        fn events(&self) -> Vec<RuntimeEventEnvelope> {
            self.events.lock().unwrap().clone()
        }
    }

    #[async_trait::async_trait]
    impl RuntimeEventSink for RecordingRuntimeEventSink {
        async fn publish_runtime_event(&self, event: RuntimeEventEnvelope) -> PortResult<()> {
            self.events.lock().unwrap().push(event);
            Ok(())
        }
    }

    fn runtime_services_with_events(events: Arc<dyn RuntimeEventSink>) -> RuntimeServices {
        let filesystem: Arc<dyn FileSystemPort> =
            Arc::new(TestRuntimePort::new(RuntimeServiceCapability::FileSystem));
        let workspace: Arc<dyn WorkspacePort> =
            Arc::new(TestRuntimePort::new(RuntimeServiceCapability::Workspace));
        let session_store: Arc<dyn SessionStorePort> =
            Arc::new(TestRuntimePort::new(RuntimeServiceCapability::SessionStore));
        let clock: Arc<dyn ClockPort> =
            Arc::new(TestRuntimePort::new(RuntimeServiceCapability::Clock));

        RuntimeServicesBuilder::new()
            .with_filesystem(filesystem)
            .with_workspace(workspace)
            .with_session_store(session_store)
            .with_events(events)
            .with_clock(clock)
            .build()
            .expect("runtime services")
    }

    #[tokio::test]
    async fn builder_requires_submission_port() {
        let err = AgentRuntimeBuilder::new().build().unwrap_err();
        assert_eq!(err, RuntimeBuildError::MissingSubmissionPort);
    }

    #[tokio::test]
    async fn session_compaction_requires_registered_port() {
        let ports = Arc::new(FakeAgentRuntimePorts::default());
        let runtime = AgentRuntimeBuilder::new()
            .with_submission_port(ports)
            .build()
            .expect("runtime");

        let error = runtime
            .start_session_compaction(AgentSessionCompactionRequest {
                session_id: "session-1".to_string(),
                turn_id: "turn-compact-1".to_string(),
            })
            .await
            .expect_err("missing compaction port must fail closed");

        assert!(matches!(
            error,
            RuntimeError::Port(PortError {
                kind: PortErrorKind::NotAvailable,
                ..
            })
        ));
    }

    #[tokio::test]
    async fn session_compaction_forwards_exact_session_and_turn_identity() {
        let ports = Arc::new(FakeAgentRuntimePorts::default());
        let runtime = AgentRuntimeBuilder::new()
            .with_submission_port(ports.clone())
            .with_session_compaction_port(ports.clone())
            .build()
            .expect("runtime");
        let request = AgentSessionCompactionRequest {
            session_id: "session-1".to_string(),
            turn_id: "turn-compact-1".to_string(),
        };

        let result = runtime
            .start_session_compaction(request.clone())
            .await
            .expect("start compaction");

        assert_eq!(
            result,
            AgentSessionCompactionResult {
                session_id: "session-1".to_string(),
                turn_id: "turn-compact-1".to_string(),
            }
        );
        assert_eq!(
            ports.compaction_requests.lock().unwrap().as_slice(),
            &[request]
        );
    }

    #[tokio::test]
    async fn session_fork_before_turn_forwards_exact_boundary_identity() {
        let ports = Arc::new(FakeAgentRuntimePorts::default());
        let runtime = AgentRuntimeBuilder::new()
            .with_submission_port(ports.clone())
            .with_session_fork_port(ports.clone())
            .build()
            .expect("runtime");
        let request = AgentSessionForkBeforeTurnRequest {
            workspace_id: None,
            workspace_path: "/workspace/project".to_string(),
            source_session_id: "session-1".to_string(),
            source_turn_id: "turn-2".to_string(),
            remote_connection_id: None,
            remote_ssh_host: None,
        };

        let result = runtime
            .fork_session_before_turn(request.clone())
            .await
            .expect("fork before turn");

        assert_eq!(result.session_id, "session-fork");
        assert_eq!(
            ports.before_turn_fork_requests.lock().unwrap().as_slice(),
            &[request]
        );
    }

    #[tokio::test]
    async fn session_undo_forwards_through_the_optional_runtime_port() {
        let ports = Arc::new(FakeAgentRuntimePorts::default());
        let runtime = AgentRuntimeBuilder::new()
            .with_submission_port(ports.clone())
            .with_session_revert_port(ports.clone())
            .build()
            .expect("runtime");
        let request = AgentSessionRevertRequest {
            workspace_id: None,
            workspace_path: "/workspace/project".to_string(),
            session_id: "session-1".to_string(),
            remote_connection_id: None,
            remote_ssh_host: None,
        };

        let result = runtime
            .undo_session(request.clone())
            .await
            .expect("undo session");

        assert_eq!(result.hidden_turn_count, 1);
        assert_eq!(ports.undo_requests.lock().unwrap().as_slice(), &[request]);
    }

    #[tokio::test]
    async fn builder_keeps_plugin_runtime_disabled_by_default() {
        let ports = Arc::new(FakeAgentRuntimePorts::default());
        let runtime = AgentRuntimeBuilder::new()
            .with_submission_port(ports)
            .build()
            .expect("runtime");

        assert_eq!(
            runtime.plugin_runtime().availability(),
            PluginRuntimeBinding::disabled(PluginRuntimeUnavailableReason::NotBuilt).availability()
        );
    }

    #[tokio::test]
    async fn builder_accepts_explicit_plugin_runtime_binding() {
        let ports = Arc::new(FakeAgentRuntimePorts::default());
        let runtime = AgentRuntimeBuilder::new()
            .with_submission_port(ports)
            .with_plugin_runtime(PluginRuntimeBinding::projection_only(
                PluginRuntimeUnavailableReason::UnsupportedProfile,
            ))
            .build()
            .expect("runtime");

        assert_eq!(
            runtime.plugin_runtime().availability(),
            PluginRuntimeBinding::projection_only(
                PluginRuntimeUnavailableReason::UnsupportedProfile
            )
            .availability()
        );
    }

    #[tokio::test]
    async fn builder_accepts_executable_plugin_runtime_client() {
        let ports = Arc::new(FakeAgentRuntimePorts::default());
        let runtime = AgentRuntimeBuilder::new()
            .with_submission_port(ports)
            .with_plugin_runtime(PluginRuntimeBinding::client(Arc::new(
                AvailablePluginRuntimeClient,
            )))
            .build()
            .expect("executable plugin runtime clients should build");

        assert_eq!(
            runtime.plugin_runtime().availability(),
            PluginRuntimeAvailability::Available
        );
    }

    #[tokio::test]
    async fn builder_rejects_plugin_runtime_client_that_reports_projection_only() {
        let ports = Arc::new(FakeAgentRuntimePorts::default());
        let err = AgentRuntimeBuilder::new()
            .with_submission_port(ports)
            .with_plugin_runtime(PluginRuntimeBinding::client(Arc::new(
                MisreportedPluginRuntimeClient,
            )))
            .build()
            .unwrap_err();

        assert_eq!(
            err,
            RuntimeBuildError::UnsupportedPluginRuntimeClientAvailability
        );
    }

    #[tokio::test]
    async fn create_session_with_id_uses_exact_identity() {
        let ports = Arc::new(FakeAgentRuntimePorts::default());
        let runtime = AgentRuntimeBuilder::new()
            .with_submission_port(ports.clone())
            .build()
            .expect("runtime");

        let created = runtime
            .create_session_with_id(
                "fixed-session-id".to_string(),
                AgentSessionCreateRequest {
                    session_name: "Fixed session".to_string(),
                    agent_type: "Standard".to_string(),
                    agent_route_key: None,
                    workspace_path: Some("/workspace/project".to_string()),
                    project_workspace_path: None,
                    execution_target: None,
                    workspace_id: None,
                    remote_connection_id: None,
                    remote_ssh_host: None,
                    model_id: None,
                    metadata: serde_json::Map::new(),
                },
            )
            .await
            .expect("create session");

        assert_eq!(created.session_id, "fixed-session-id");
    }

    #[tokio::test]
    async fn create_session_with_id_rejects_provider_identity_mismatch() {
        let ports = Arc::new(FakeAgentRuntimePorts::default());
        *ports.exact_session_result_id.lock().unwrap() = Some("other-session-id".to_string());
        let runtime = AgentRuntimeBuilder::new()
            .with_submission_port(ports)
            .build()
            .expect("runtime");

        let error = runtime
            .create_session_with_id(
                "fixed-session-id".to_string(),
                AgentSessionCreateRequest {
                    session_name: "Fixed session".to_string(),
                    agent_type: "Standard".to_string(),
                    agent_route_key: None,
                    workspace_path: Some("/workspace/project".to_string()),
                    project_workspace_path: None,
                    execution_target: None,
                    workspace_id: None,
                    remote_connection_id: None,
                    remote_ssh_host: None,
                    model_id: None,
                    metadata: serde_json::Map::new(),
                },
            )
            .await
            .expect_err("runtime must reject a provider identity mismatch");

        assert!(matches!(
            error,
            RuntimeError::Port(PortError {
                kind: PortErrorKind::Backend,
                ..
            })
        ));
    }

    #[tokio::test]
    async fn run_creates_session_and_submits_turn_through_ports() {
        let ports = Arc::new(FakeAgentRuntimePorts::default());
        let runtime = AgentRuntimeBuilder::new()
            .with_submission_port(ports.clone())
            .build()
            .expect("runtime");

        let mut metadata = serde_json::Map::new();
        metadata.insert("source".to_string(), serde_json::json!("sdk-test"));

        let handle = runtime
            .run(
                AgentRunRequest::new(
                    SessionSelector::create(
                        "SDK Session",
                        "Standard",
                        Some("/workspace/project".to_string()),
                    )
                    .with_metadata(metadata.clone()),
                    "hello",
                )
                .with_turn_id("turn_1")
                .with_source(AgentSubmissionSource::Cli),
            )
            .await
            .expect("run");

        assert_eq!(handle.session_id, "session_1");
        assert_eq!(handle.turn_id, "turn_1");
        assert_eq!(handle.agent_type.as_deref(), Some("Standard"));
        assert!(handle.accepted);
        assert_eq!(ports.created_sessions.lock().unwrap()[0].metadata, metadata);
        assert_eq!(
            ports.submitted_messages.lock().unwrap()[0].session_id,
            "session_1"
        );
        assert!(handle.events.is_none());
    }

    #[tokio::test]
    async fn run_existing_session_resolves_agent_type_without_creating_session() {
        let ports = Arc::new(FakeAgentRuntimePorts {
            resolved_agent_type: Some("Claw".to_string()),
            ..Default::default()
        });
        let runtime = AgentRuntimeBuilder::new()
            .with_submission_port(ports.clone())
            .build()
            .expect("runtime");

        let handle = runtime
            .run(AgentRunRequest::new(
                SessionSelector::existing("session_existing"),
                "continue",
            ))
            .await
            .expect("run existing session");

        assert_eq!(handle.session_id, "session_existing");
        assert_eq!(handle.agent_type.as_deref(), Some("Claw"));
        assert!(ports.created_sessions.lock().unwrap().is_empty());
        assert_eq!(
            ports.submitted_messages.lock().unwrap()[0].session_id,
            "session_existing"
        );
    }

    #[tokio::test]
    async fn cancel_turn_requires_registered_cancellation_port() {
        let ports = Arc::new(FakeAgentRuntimePorts::default());
        let runtime = AgentRuntimeBuilder::new()
            .with_submission_port(ports)
            .build()
            .expect("runtime");

        let err = runtime
            .cancel_turn(AgentTurnCancellationRequest {
                session_id: "session_1".to_string(),
                turn_id: Some("turn_1".to_string()),
                source: None,
                requester_session_id: None,
                reason: None,
                wait_timeout_ms: None,
                cancel_descendants: true,
            })
            .await
            .unwrap_err();

        assert_eq!(err, RuntimeError::MissingCancellationPort);
    }

    #[tokio::test]
    async fn cancel_turn_delegates_to_cancellation_port() {
        let ports = Arc::new(FakeAgentRuntimePorts::default());
        let runtime = AgentRuntimeBuilder::new()
            .with_submission_port(ports.clone())
            .with_cancellation_port(ports.clone())
            .build()
            .expect("runtime");

        let result = runtime
            .cancel_turn(AgentTurnCancellationRequest {
                session_id: "session_1".to_string(),
                turn_id: Some("turn_1".to_string()),
                source: Some(AgentSubmissionSource::RemoteRelay),
                requester_session_id: Some("requester_session".to_string()),
                reason: Some("user_cancelled".to_string()),
                wait_timeout_ms: Some(100),
                cancel_descendants: true,
            })
            .await
            .expect("cancel");

        assert!(result.requested);
        assert_eq!(result.turn_id.as_deref(), Some("turn_1"));
        assert_eq!(ports.cancelled_turns.lock().unwrap().len(), 1);
        assert_eq!(
            ports.cancelled_turns.lock().unwrap()[0]
                .requester_session_id
                .as_deref(),
            Some("requester_session")
        );
    }

    #[tokio::test]
    async fn interrupt_turn_delegates_to_cancellation_owner() {
        let ports = Arc::new(FakeAgentRuntimePorts::default());
        let runtime = AgentRuntimeBuilder::new()
            .with_submission_port(ports.clone())
            .with_cancellation_port(ports.clone())
            .build()
            .expect("runtime");

        let result = runtime
            .interrupt_turn(AgentTurnInterruptionRequest {
                session_id: "session_1".to_string(),
                turn_id: "turn_1".to_string(),
                source: Some(AgentSubmissionSource::DesktopUi),
                wait_timeout_ms: Some(30_000),
            })
            .await
            .expect("interrupt");

        assert!(result.requested);
        assert_eq!(result.turn_id, "turn_1");
        assert_eq!(ports.interrupted_turns.lock().unwrap().len(), 1);
    }

    #[test]
    fn restore_request_reads_legacy_payload_and_round_trips_id_only_scope() {
        let legacy: AgentSessionRestoreRequest = serde_json::from_value(serde_json::json!({
            "workspacePath": "/project", "sessionId": "session-1"
        }))
        .unwrap();
        assert!(legacy.workspace_id.is_none());
        assert_eq!(
            serde_json::from_value::<AgentSessionRestoreRequest>(
                serde_json::to_value(&legacy).unwrap()
            )
            .unwrap(),
            legacy
        );
        let current: AgentSessionRestoreRequest = serde_json::from_value(serde_json::json!({
            "workspaceId": "workspace-1", "sessionId": "session-1"
        }))
        .unwrap();
        assert!(current.workspace_path.is_empty());
        let json = serde_json::to_value(&current).unwrap();
        assert!(json.get("workspacePath").is_none());
        assert_eq!(json["workspaceId"], "workspace-1");
        assert_eq!(
            serde_json::from_value::<AgentSessionRestoreRequest>(json).unwrap(),
            current
        );
    }

    #[tokio::test]
    async fn session_management_requires_registered_port() {
        let ports = Arc::new(FakeAgentRuntimePorts::default());
        let runtime = AgentRuntimeBuilder::new()
            .with_submission_port(ports)
            .build()
            .expect("runtime");

        let err = runtime
            .list_sessions(AgentSessionListRequest {
                workspace_id: None,
                workspace_path: "/workspace/project".to_string(),
                remote_connection_id: None,
                remote_ssh_host: None,
            })
            .await
            .unwrap_err();

        assert_eq!(err, RuntimeError::MissingSessionManagementPort);
    }

    #[tokio::test]
    async fn session_management_delegates_to_registered_port() {
        let ports = Arc::new(FakeAgentRuntimePorts::default());
        let runtime = AgentRuntimeBuilder::new()
            .with_submission_port(ports.clone())
            .with_session_management_port(ports.clone())
            .build()
            .expect("runtime");

        let sessions = runtime
            .list_sessions(AgentSessionListRequest {
                workspace_id: None,
                workspace_path: "/workspace/project".to_string(),
                remote_connection_id: None,
                remote_ssh_host: None,
            })
            .await
            .expect("list sessions");
        runtime
            .delete_session(AgentSessionDeleteRequest {
                workspace_id: None,
                workspace_path: "/workspace/project".to_string(),
                session_id: "session_1".to_string(),
                remote_connection_id: None,
                remote_ssh_host: None,
            })
            .await
            .expect("delete session");
        runtime
            .rename_session(AgentSessionRenameRequest {
                workspace_id: None,
                workspace_path: "/workspace/project".to_string(),
                session_id: "session_1".to_string(),
                session_name: "Renamed".to_string(),
                remote_connection_id: None,
                remote_ssh_host: None,
            })
            .await
            .expect("rename session");
        runtime
            .archive_session(AgentSessionArchiveRequest {
                workspace_id: None,
                workspace_path: "/workspace/project".to_string(),
                session_id: "session_1".to_string(),
                remote_connection_id: None,
                remote_ssh_host: None,
            })
            .await
            .expect("archive session");
        runtime
            .set_session_archived(AgentSessionArchiveStateRequest {
                workspace_id: None,
                workspace_path: "/workspace/project".to_string(),
                session_id: "session_1".to_string(),
                archived: false,
                remote_connection_id: None,
                remote_ssh_host: None,
            })
            .await
            .expect("unarchive session");
        let workspace_binding = runtime
            .resolve_session_workspace_binding(AgentSessionWorkspaceRequest {
                session_id: "session_1".to_string(),
            })
            .await
            .expect("resolve workspace binding")
            .expect("workspace binding");

        assert_eq!(sessions[0].session_id, "session_1");
        assert_eq!(
            workspace_binding.workspace_id.as_deref(),
            Some("workspace_1")
        );
        assert_eq!(workspace_binding.workspace_path, "/workspace/project");
        assert_eq!(
            workspace_binding.remote_connection_id.as_deref(),
            Some("conn-1")
        );
        assert_eq!(ports.listed_sessions.lock().unwrap().len(), 1);
        assert_eq!(ports.deleted_sessions.lock().unwrap().len(), 1);
        assert_eq!(ports.renamed_sessions.lock().unwrap().len(), 1);
        assert_eq!(ports.archived_sessions.lock().unwrap().len(), 1);
        assert_eq!(ports.archive_state_updates.lock().unwrap().len(), 1);
        assert_eq!(ports.workspace_binding_requests.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn local_command_turn_requires_registered_port() {
        let ports = Arc::new(FakeAgentRuntimePorts::default());
        let runtime = AgentRuntimeBuilder::new()
            .with_submission_port(ports)
            .build()
            .expect("runtime");

        let error = runtime
            .record_completed_local_command_turn(AgentLocalCommandTurnRecordRequest {
                session_id: "session_1".to_string(),
                content: "report".to_string(),
                turn_id: None,
                timestamp_ms: None,
                metadata: serde_json::Map::new(),
            })
            .await
            .unwrap_err();

        assert_eq!(error, RuntimeError::MissingLocalCommandTurnPort);
    }

    #[tokio::test]
    async fn local_command_turn_delegates_to_registered_port() {
        let ports = Arc::new(FakeAgentRuntimePorts::default());
        let runtime = AgentRuntimeBuilder::new()
            .with_submission_port(ports.clone())
            .with_local_command_turn_port(ports.clone())
            .build()
            .expect("runtime");
        let mut metadata = serde_json::Map::new();
        metadata.insert("kind".to_string(), serde_json::json!("usage_report"));

        let result = runtime
            .record_completed_local_command_turn(AgentLocalCommandTurnRecordRequest {
                session_id: "session_1".to_string(),
                content: "report".to_string(),
                turn_id: Some("turn_1".to_string()),
                timestamp_ms: Some(1000),
                metadata,
            })
            .await
            .expect("record local command turn");

        assert_eq!(result.turn_id, "turn_1");
        assert_eq!(result.storage_turn_index, 0);

        let requests = ports.local_command_turns.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].turn_id.as_deref(), Some("turn_1"));
        assert_eq!(requests[0].metadata["kind"], "usage_report");
    }

    #[tokio::test]
    async fn user_shell_command_requires_registered_port() {
        let ports = Arc::new(FakeAgentRuntimePorts::default());
        let runtime = AgentRuntimeBuilder::new()
            .with_submission_port(ports)
            .build()
            .expect("runtime");

        let error = runtime
            .run_user_shell_command(AgentUserShellCommandRequest {
                session_id: "session_1".to_string(),
                turn_id: "turn_1".to_string(),
                command: "git status".to_string(),
            })
            .await
            .unwrap_err();

        assert!(matches!(
            error,
            RuntimeError::Port(PortError {
                kind: PortErrorKind::NotAvailable,
                ..
            })
        ));
    }

    #[tokio::test]
    async fn user_shell_command_delegates_exact_request_and_identity() {
        let ports = Arc::new(FakeAgentRuntimePorts::default());
        let runtime = AgentRuntimeBuilder::new()
            .with_submission_port(ports.clone())
            .with_user_shell_command_port(ports.clone())
            .build()
            .expect("runtime");
        let request = AgentUserShellCommandRequest {
            session_id: "session_1".to_string(),
            turn_id: "turn_1".to_string(),
            command: "git status --short".to_string(),
        };

        let result = runtime
            .run_user_shell_command(request.clone())
            .await
            .expect("run user shell command");

        assert_eq!(
            result,
            AgentUserShellCommandResult {
                session_id: "session_1".to_string(),
                turn_id: "turn_1".to_string(),
            }
        );
        assert_eq!(
            ports.user_shell_commands.lock().unwrap().as_slice(),
            [request]
        );
    }

    #[tokio::test]
    async fn thread_goal_management_requires_registered_port() {
        let ports = Arc::new(FakeAgentRuntimePorts::default());
        let runtime = AgentRuntimeBuilder::new()
            .with_submission_port(ports)
            .build()
            .expect("runtime");

        let err = runtime
            .get_thread_goal(AgentThreadGoalGetRequest {
                session_id: "session_1".to_string(),
                workspace_path: "/workspace/project".to_string(),
                remote_connection_id: None,
                remote_ssh_host: None,
            })
            .await
            .unwrap_err();

        assert_eq!(err, RuntimeError::MissingThreadGoalManagementPort);
    }

    #[tokio::test]
    async fn thread_goal_management_delegates_to_registered_port() {
        let ports = Arc::new(FakeAgentRuntimePorts::default());
        let runtime = AgentRuntimeBuilder::new()
            .with_submission_port(ports.clone())
            .with_thread_goal_management_port(ports.clone())
            .build()
            .expect("runtime");

        let goal = runtime
            .get_thread_goal(AgentThreadGoalGetRequest {
                session_id: "session_1".to_string(),
                workspace_path: "/workspace/project".to_string(),
                remote_connection_id: Some("conn-1".to_string()),
                remote_ssh_host: Some("host-1".to_string()),
            })
            .await
            .expect("get goal")
            .expect("goal");
        let created = runtime
            .create_thread_goal(AgentThreadGoalCreateRequest {
                session_id: "session_1".to_string(),
                workspace_path: "/workspace/project".to_string(),
                objective: "Ship runtime port".to_string(),
                token_budget: Some(1000),
            })
            .await
            .expect("create goal");
        let updated = runtime
            .update_thread_goal_status(AgentThreadGoalUpdateStatusRequest {
                session_id: "session_1".to_string(),
                workspace_path: "/workspace/project".to_string(),
                status: ThreadGoalStatus::Complete,
                turn_id: Some("turn_1".to_string()),
            })
            .await
            .expect("update goal");

        assert_eq!(goal.status, ThreadGoalStatus::Active);
        assert_eq!(created.objective, "Ship runtime port");
        assert_eq!(updated.status, ThreadGoalStatus::Complete);
        let goal_gets = ports.thread_goal_gets.lock().unwrap();
        assert_eq!(goal_gets.len(), 1);
        assert_eq!(goal_gets[0].remote_connection_id.as_deref(), Some("conn-1"));
        assert_eq!(goal_gets[0].remote_ssh_host.as_deref(), Some("host-1"));
        assert_eq!(
            ports.thread_goal_creates.lock().unwrap()[0].token_budget,
            Some(1000)
        );
        assert_eq!(
            ports.thread_goal_updates.lock().unwrap()[0]
                .turn_id
                .as_deref(),
            Some("turn_1")
        );
    }

    #[tokio::test]
    async fn session_restore_and_transcript_read_delegate_to_registered_ports() {
        let ports = Arc::new(FakeAgentRuntimePorts::default());
        let runtime = AgentRuntimeBuilder::new()
            .with_submission_port(ports.clone())
            .with_session_management_port(ports.clone())
            .with_session_restore_port(ports.clone())
            .with_session_transcript_reader(ports.clone())
            .build()
            .expect("runtime");

        let restored = runtime
            .restore_session(AgentSessionRestoreRequest {
                workspace_id: None,
                workspace_path: "/workspace/project".to_string(),
                session_id: "session_1".to_string(),
                include_internal: false,
                remote_connection_id: None,
                remote_ssh_host: None,
            })
            .await
            .expect("restore session");
        let transcript = runtime
            .read_session_transcript(SessionTranscriptRequest {
                session_id: "session_1".to_string(),
                turn_id: None,
            })
            .await
            .expect("read transcript");

        assert_eq!(restored.session.session_id, "session_1");
        assert_eq!(transcript.messages[0].id.as_deref(), Some("message_1"));
        assert_eq!(ports.restored_sessions.lock().unwrap().len(), 1);
        assert_eq!(ports.transcript_requests.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn lineage_query_and_transcript_read_delegate_to_one_owner() {
        let ports = Arc::new(FakeAgentRuntimePorts::default());
        let runtime = AgentRuntimeBuilder::new()
            .with_submission_port(ports.clone())
            .with_session_lineage_port(ports.clone())
            .build()
            .expect("runtime");

        let snapshot = runtime
            .get_session_lineage(AgentSessionLineageRequest {
                workspace_id: None,
                workspace_path: "/workspace/project".to_string(),
                anchor_session_id: "child_1".to_string(),
                remote_connection_id: None,
                remote_ssh_host: None,
            })
            .await
            .expect("query lineage")
            .expect("lineage");
        let inspection = runtime
            .read_lineage_session_transcript(AgentSessionLineageTranscriptRequest {
                workspace_id: None,
                workspace_path: "/workspace/project".to_string(),
                root_session_id: "root_1".to_string(),
                session_id: "child_1".to_string(),
                required_settled_turn_ids: Vec::new(),
                remote_connection_id: None,
                remote_ssh_host: None,
            })
            .await
            .expect("read child transcript");

        assert_eq!(snapshot.root_session_id, "root_1");
        assert_eq!(inspection.transcript.session_id, "child_1");
        assert_eq!(inspection.active_turn_id.as_deref(), Some("child_turn"));
        assert_eq!(ports.lineage_requests.lock().unwrap().len(), 1);
        assert_eq!(ports.lineage_transcript_requests.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn lineage_cancellation_delegates_scope_and_execution_to_one_owner() {
        let ports = Arc::new(FakeAgentRuntimePorts::default());
        let runtime = AgentRuntimeBuilder::new()
            .with_submission_port(ports.clone())
            .with_session_lineage_port(ports.clone())
            .build()
            .expect("runtime");

        let result = runtime
            .cancel_lineage_session(AgentSessionLineageCancellationRequest {
                workspace_id: None,
                workspace_path: "/workspace/project".to_string(),
                root_session_id: "root_1".to_string(),
                session_id: "child_1".to_string(),
                expected_active_turn_id: Some("child_turn".to_string()),
                source: Some(AgentSubmissionSource::Cli),
                reason: Some("user_cancelled".to_string()),
                wait_timeout_ms: Some(5_000),
                remote_connection_id: None,
                remote_ssh_host: None,
            })
            .await
            .expect("cancel child");

        assert!(result.requested);
        let cancellations = ports.cancelled_turns.lock().unwrap();
        assert_eq!(cancellations.len(), 1);
        assert_eq!(cancellations[0].session_id, "child_1");
        assert!(cancellations[0].cancel_descendants);
        drop(cancellations);

        let error = runtime
            .cancel_lineage_session(AgentSessionLineageCancellationRequest {
                workspace_id: None,
                workspace_path: "/workspace/project".to_string(),
                root_session_id: "root_1".to_string(),
                session_id: "outside".to_string(),
                expected_active_turn_id: Some("outside_turn".to_string()),
                source: None,
                reason: None,
                wait_timeout_ms: None,
                remote_connection_id: None,
                remote_ssh_host: None,
            })
            .await
            .expect_err("reject unrelated session");

        assert!(matches!(
            error,
            RuntimeError::Port(PortError {
                kind: PortErrorKind::InvalidRequest,
                ..
            })
        ));
        assert_eq!(ports.cancelled_turns.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn session_mode_update_delegates_to_registered_port() {
        let ports = Arc::new(FakeAgentRuntimePorts::default());
        let runtime = AgentRuntimeBuilder::new()
            .with_submission_port(ports.clone())
            .with_session_mode_port(ports.clone())
            .build()
            .expect("runtime");

        runtime
            .update_session_mode(AgentSessionModeUpdateRequest {
                session_id: "session_1".to_string(),
                mode_id: "plan".to_string(),
                agent_route_key: None,
            })
            .await
            .expect("update session mode");

        assert_eq!(
            ports.mode_updates.lock().unwrap().as_slice(),
            &[AgentSessionModeUpdateRequest {
                session_id: "session_1".to_string(),
                mode_id: "plan".to_string(),
                agent_route_key: None,
            }]
        );
    }

    #[tokio::test]
    async fn session_mode_update_requires_registered_port() {
        let ports = Arc::new(FakeAgentRuntimePorts::default());
        let runtime = AgentRuntimeBuilder::new()
            .with_submission_port(ports)
            .build()
            .expect("runtime");

        let error = runtime
            .update_session_mode(AgentSessionModeUpdateRequest {
                session_id: "session_1".to_string(),
                mode_id: "plan".to_string(),
                agent_route_key: None,
            })
            .await
            .unwrap_err();

        assert!(matches!(
            error,
            RuntimeError::Port(PortError {
                kind: PortErrorKind::NotAvailable,
                ..
            })
        ));
    }

    #[test]
    fn session_restore_contract_serializes_runtime_owned_state() {
        let request = AgentSessionRestoreRequest {
            workspace_id: None,
            workspace_path: "/workspace/project".to_string(),
            session_id: "session_1".to_string(),
            include_internal: true,
            remote_connection_id: Some("conn-1".to_string()),
            remote_ssh_host: Some("host-1".to_string()),
        };
        let result = AgentSessionRestoreResult {
            session: AgentSessionSummary {
                session_id: "session_1".to_string(),
                session_name: "Main".to_string(),
                agent_type: "Standard".to_string(),
                model_id: Some("provider/model".to_string()),
                reasoning_preset: Some("high".to_string()),
                last_user_dialog_agent_type: Some("plan".to_string()),
                last_submitted_agent_type: Some("Standard".to_string()),
                turn_count: 3,
                created_at_ms: 1000,
                last_active_at_ms: 2000,
            },
            state: SessionState::Error {
                error: "recoverable failure".to_string(),
                recoverable: true,
            },
        };

        let request_json = serde_json::to_value(request).expect("serialize restore request");
        let result_json = serde_json::to_value(result).expect("serialize restore result");

        assert_eq!(request_json["workspacePath"], "/workspace/project");
        assert_eq!(request_json["remoteConnectionId"], "conn-1");
        assert_eq!(request_json["remoteSshHost"], "host-1");
        assert_eq!(result_json["state"]["Error"]["recoverable"], true);
    }

    #[tokio::test]
    async fn session_restore_requires_registered_port() {
        let ports = Arc::new(FakeAgentRuntimePorts::default());
        let runtime = AgentRuntimeBuilder::new()
            .with_submission_port(ports)
            .build()
            .expect("runtime");

        let error = runtime
            .restore_session(AgentSessionRestoreRequest {
                workspace_id: None,
                workspace_path: "/workspace/project".to_string(),
                session_id: "session_1".to_string(),
                include_internal: false,
                remote_connection_id: None,
                remote_ssh_host: None,
            })
            .await
            .unwrap_err();

        assert_eq!(error, RuntimeError::MissingSessionRestorePort);
    }

    #[test]
    fn event_subscription_requires_configured_source() {
        let ports = Arc::new(FakeAgentRuntimePorts::default());
        let runtime = AgentRuntimeBuilder::new()
            .with_submission_port(ports)
            .build()
            .expect("runtime");

        assert_eq!(
            runtime.subscribe_events().unwrap_err(),
            RuntimeError::MissingEventSource
        );
    }

    #[test]
    fn runtime_error_message_preserves_port_error_text() {
        let error = RuntimeError::Port(PortError::new(
            openbitfun_runtime_ports::PortErrorKind::Backend,
            "original backend message",
        ));

        assert_eq!(error.into_message(), "original backend message");
    }

    #[tokio::test]
    async fn transcript_read_requires_registered_reader() {
        let ports = Arc::new(FakeAgentRuntimePorts::default());
        let runtime = AgentRuntimeBuilder::new()
            .with_submission_port(ports)
            .build()
            .expect("runtime");

        let error = runtime
            .read_session_transcript(SessionTranscriptRequest {
                session_id: "session_1".to_string(),
                turn_id: None,
            })
            .await
            .unwrap_err();

        assert_eq!(error, RuntimeError::MissingSessionTranscriptReader);
    }

    #[tokio::test]
    async fn submit_dialog_turn_requires_registered_dialog_turn_port() {
        let ports = Arc::new(FakeAgentRuntimePorts::default());
        let runtime = AgentRuntimeBuilder::new()
            .with_submission_port(ports)
            .build()
            .expect("runtime");

        let err = runtime
            .submit_dialog_turn(AgentDialogTurnRequest {
                session_id: "session_1".to_string(),
                message: "hello".to_string(),
                output_schema: None,
                original_message: None,
                turn_id: Some("turn_1".to_string()),
                execution: Default::default(),
                agent_type: "Standard".to_string(),
                workspace_path: Some("/workspace/project".to_string()),
                workspace_id: None,
                remote_connection_id: None,
                remote_ssh_host: None,
                policy: DialogSubmissionPolicy::new(
                    AgentSubmissionSource::RemoteRelay,
                    DialogQueuePriority::Normal,
                ),
                reply_route: None,
                prepended_reminders: Vec::new(),
                attachments: Vec::new(),
                metadata: serde_json::Map::new(),
            })
            .await
            .unwrap_err();

        assert_eq!(err, RuntimeError::MissingDialogTurnPort);
    }

    #[tokio::test]
    async fn submit_dialog_turn_delegates_to_dialog_turn_port() {
        #[derive(Debug, Default)]
        struct RecordingDialogTurnPort {
            requests: Mutex<Vec<AgentDialogTurnRequest>>,
        }

        #[async_trait::async_trait]
        impl openbitfun_runtime_ports::AgentDialogTurnPort for RecordingDialogTurnPort {
            async fn submit_dialog_turn(
                &self,
                request: AgentDialogTurnRequest,
            ) -> PortResult<DialogSubmitOutcome> {
                self.requests.lock().unwrap().push(request.clone());
                Ok(DialogSubmitOutcome::Queued {
                    session_id: request.session_id,
                    turn_id: request.turn_id.unwrap_or_else(|| "generated".to_string()),
                })
            }
        }

        let ports = Arc::new(FakeAgentRuntimePorts::default());
        let dialog_turns = Arc::new(RecordingDialogTurnPort::default());
        let runtime = AgentRuntimeBuilder::new()
            .with_submission_port(ports)
            .with_dialog_turn_port(dialog_turns.clone())
            .build()
            .expect("runtime");

        let result = runtime
            .submit_dialog_turn(AgentDialogTurnRequest {
                session_id: "session_1".to_string(),
                message: "hello".to_string(),
                output_schema: None,
                original_message: Some("hello".to_string()),
                turn_id: Some("turn_1".to_string()),
                execution: Default::default(),
                agent_type: "Standard".to_string(),
                workspace_path: Some("/workspace/project".to_string()),
                workspace_id: None,
                remote_connection_id: None,
                remote_ssh_host: None,
                policy: DialogSubmissionPolicy::new(
                    AgentSubmissionSource::RemoteRelay,
                    DialogQueuePriority::High,
                ),
                reply_route: None,
                prepended_reminders: Vec::new(),
                attachments: vec![AgentInputAttachment::remote_image(
                    "remote-image-1",
                    "clip.png",
                    "data:image/png;base64,abc",
                )],
                metadata: serde_json::Map::new(),
            })
            .await
            .expect("dialog turn");

        assert_eq!(
            result,
            DialogSubmitOutcome::Queued {
                session_id: "session_1".to_string(),
                turn_id: "turn_1".to_string(),
            }
        );
        assert_eq!(dialog_turns.requests.lock().unwrap().len(), 1);
        assert_eq!(
            dialog_turns.requests.lock().unwrap()[0]
                .policy
                .queue_priority,
            DialogQueuePriority::High
        );
        assert_eq!(
            dialog_turns.requests.lock().unwrap()[0].attachments[0].kind,
            "remote_image"
        );
    }

    #[tokio::test]
    async fn recover_interrupted_turn_delegates_and_validates_identity() {
        #[derive(Debug)]
        struct RecoveryPort;

        #[async_trait::async_trait]
        impl openbitfun_runtime_ports::AgentDialogTurnPort for RecoveryPort {
            async fn submit_dialog_turn(
                &self,
                _request: AgentDialogTurnRequest,
            ) -> PortResult<DialogSubmitOutcome> {
                unreachable!("recovery must not submit a new turn")
            }

            async fn recover_interrupted_turn(
                &self,
                request: AgentDialogTurnRecoveryRequest,
            ) -> PortResult<AgentDialogTurnRecoveryOutcome> {
                Ok(AgentDialogTurnRecoveryOutcome {
                    session_id: request.session_id,
                    turn_id: request.turn_id,
                    execution_generation: request.execution_generation + 1,
                })
            }
        }

        let runtime = AgentRuntimeBuilder::new()
            .with_submission_port(Arc::new(FakeAgentRuntimePorts::default()))
            .with_dialog_turn_port(Arc::new(RecoveryPort))
            .build()
            .expect("runtime");
        let result = runtime
            .recover_interrupted_turn(AgentDialogTurnRecoveryRequest {
                session_id: "session_1".to_string(),
                turn_id: "turn_1".to_string(),
                execution_generation: 0,
                workspace_path: Some("/workspace/project".to_string()),
                workspace_id: None,
                remote_connection_id: None,
                remote_ssh_host: None,
            })
            .await
            .expect("recover");

        assert_eq!(result.session_id, "session_1");
        assert_eq!(result.turn_id, "turn_1");
        assert_eq!(result.execution_generation, 1);
    }

    #[tokio::test]
    async fn submit_dialog_turn_rejects_provider_session_identity_mismatch() {
        #[derive(Debug)]
        struct MismatchedDialogTurnPort;

        #[async_trait::async_trait]
        impl openbitfun_runtime_ports::AgentDialogTurnPort for MismatchedDialogTurnPort {
            async fn submit_dialog_turn(
                &self,
                request: AgentDialogTurnRequest,
            ) -> PortResult<DialogSubmitOutcome> {
                Ok(DialogSubmitOutcome::Started {
                    session_id: "different-session".to_string(),
                    turn_id: request.turn_id.unwrap_or_else(|| "generated".to_string()),
                })
            }
        }

        let runtime = AgentRuntimeBuilder::new()
            .with_submission_port(Arc::new(FakeAgentRuntimePorts::default()))
            .with_dialog_turn_port(Arc::new(MismatchedDialogTurnPort))
            .build()
            .expect("runtime");

        let error = runtime
            .submit_dialog_turn(AgentDialogTurnRequest {
                session_id: "requested-session".to_string(),
                message: "hello".to_string(),
                output_schema: None,
                original_message: None,
                turn_id: Some("turn-1".to_string()),
                execution: Default::default(),
                agent_type: "Standard".to_string(),
                workspace_path: Some("/workspace/project".to_string()),
                workspace_id: None,
                remote_connection_id: None,
                remote_ssh_host: None,
                policy: DialogSubmissionPolicy::for_source(AgentSubmissionSource::SdkHost),
                reply_route: None,
                prepended_reminders: Vec::new(),
                attachments: Vec::new(),
                metadata: serde_json::Map::new(),
            })
            .await
            .expect_err("provider session mismatch must fail closed");

        assert!(matches!(
            error,
            RuntimeError::Port(PortError {
                kind: PortErrorKind::Backend,
                ..
            })
        ));
        assert!(error.into_message().contains("requested-session"));
    }

    #[tokio::test]
    async fn steer_dialog_turn_requires_registered_dialog_turn_port() {
        let runtime = AgentRuntimeBuilder::new()
            .with_submission_port(Arc::new(FakeAgentRuntimePorts::default()))
            .build()
            .expect("runtime");

        let error = runtime
            .steer_dialog_turn(openbitfun_runtime_ports::AgentDialogSteerRequest {
                session_id: "session_1".to_string(),
                turn_id: "turn_1".to_string(),
                content: "check tests".to_string(),
                display_content: None,
                attachments: Vec::new(),
                metadata: serde_json::Map::new(),
            })
            .await
            .expect_err("steering without a dialog-turn provider must fail");

        assert_eq!(error, RuntimeError::MissingDialogTurnPort);
    }

    #[tokio::test]
    async fn steer_dialog_turn_delegates_and_validates_exact_turn_identity() {
        #[derive(Debug, Default)]
        struct RecordingSteerPort {
            requests: Mutex<Vec<openbitfun_runtime_ports::AgentDialogSteerRequest>>,
        }

        #[async_trait::async_trait]
        impl openbitfun_runtime_ports::AgentDialogTurnPort for RecordingSteerPort {
            async fn submit_dialog_turn(
                &self,
                request: AgentDialogTurnRequest,
            ) -> PortResult<DialogSubmitOutcome> {
                Ok(DialogSubmitOutcome::Started {
                    session_id: request.session_id,
                    turn_id: request.turn_id.unwrap_or_else(|| "generated".to_string()),
                })
            }

            async fn steer_dialog_turn(
                &self,
                request: openbitfun_runtime_ports::AgentDialogSteerRequest,
            ) -> PortResult<openbitfun_runtime_ports::DialogSteerOutcome> {
                self.requests.lock().unwrap().push(request.clone());
                Ok(openbitfun_runtime_ports::DialogSteerOutcome::Buffered {
                    session_id: request.session_id,
                    turn_id: request.turn_id,
                    steering_id: "steer_1".to_string(),
                })
            }
        }

        let port = Arc::new(RecordingSteerPort::default());
        let runtime = AgentRuntimeBuilder::new()
            .with_submission_port(Arc::new(FakeAgentRuntimePorts::default()))
            .with_dialog_turn_port(port.clone())
            .build()
            .expect("runtime");
        let request = openbitfun_runtime_ports::AgentDialogSteerRequest {
            session_id: "session_1".to_string(),
            turn_id: "turn_1".to_string(),
            content: "check tests".to_string(),
            display_content: Some("Check tests".to_string()),
            attachments: Vec::new(),
            metadata: serde_json::Map::new(),
        };

        let result = runtime
            .steer_dialog_turn(request.clone())
            .await
            .expect("steer dialog turn");

        assert_eq!(port.requests.lock().unwrap().as_slice(), &[request]);
        assert_eq!(
            result,
            openbitfun_runtime_ports::DialogSteerOutcome::Buffered {
                session_id: "session_1".to_string(),
                turn_id: "turn_1".to_string(),
                steering_id: "steer_1".to_string(),
            }
        );
    }

    #[tokio::test]
    async fn steer_dialog_turn_rejects_provider_turn_identity_mismatch() {
        #[derive(Debug)]
        struct MismatchedSteerPort;

        #[async_trait::async_trait]
        impl openbitfun_runtime_ports::AgentDialogTurnPort for MismatchedSteerPort {
            async fn submit_dialog_turn(
                &self,
                request: AgentDialogTurnRequest,
            ) -> PortResult<DialogSubmitOutcome> {
                Ok(DialogSubmitOutcome::Started {
                    session_id: request.session_id,
                    turn_id: request.turn_id.unwrap_or_else(|| "generated".to_string()),
                })
            }

            async fn steer_dialog_turn(
                &self,
                request: openbitfun_runtime_ports::AgentDialogSteerRequest,
            ) -> PortResult<openbitfun_runtime_ports::DialogSteerOutcome> {
                Ok(openbitfun_runtime_ports::DialogSteerOutcome::Buffered {
                    session_id: request.session_id,
                    turn_id: "different-turn".to_string(),
                    steering_id: "steer_1".to_string(),
                })
            }
        }

        let runtime = AgentRuntimeBuilder::new()
            .with_submission_port(Arc::new(FakeAgentRuntimePorts::default()))
            .with_dialog_turn_port(Arc::new(MismatchedSteerPort))
            .build()
            .expect("runtime");

        let error = runtime
            .steer_dialog_turn(openbitfun_runtime_ports::AgentDialogSteerRequest {
                session_id: "session_1".to_string(),
                turn_id: "turn_1".to_string(),
                content: "check tests".to_string(),
                display_content: None,
                attachments: Vec::new(),
                metadata: serde_json::Map::new(),
            })
            .await
            .expect_err("provider turn mismatch must fail closed");

        assert!(matches!(
            error,
            RuntimeError::Port(PortError {
                kind: PortErrorKind::Backend,
                ..
            })
        ));
        assert!(error.into_message().contains("different-turn"));
    }

    #[tokio::test]
    async fn deliver_background_result_requires_registered_lifecycle_port() {
        let ports = Arc::new(FakeAgentRuntimePorts::default());
        let runtime = AgentRuntimeBuilder::new()
            .with_submission_port(ports)
            .build()
            .expect("runtime");

        let err = runtime
            .deliver_background_result(AgentBackgroundResultRequest {
                session_id: "session_1".to_string(),
                agent_type: "Standard".to_string(),
                workspace_path: None,
                remote_connection_id: None,
                remote_ssh_host: None,
                content: "result".to_string(),
                display_content: None,
                metadata: serde_json::Map::new(),
            })
            .await
            .unwrap_err();

        assert_eq!(err, RuntimeError::MissingLifecycleDeliveryPort);
    }

    #[tokio::test]
    async fn lifecycle_delivery_delegates_to_registered_port() {
        #[derive(Debug, Default)]
        struct RecordingLifecycleDeliveryPort {
            background_results: Mutex<Vec<AgentBackgroundResultRequest>>,
            thread_goals: Mutex<Vec<AgentThreadGoalDeliveryRequest>>,
        }

        #[async_trait::async_trait]
        impl AgentLifecycleDeliveryPort for RecordingLifecycleDeliveryPort {
            async fn deliver_background_result(
                &self,
                request: AgentBackgroundResultRequest,
            ) -> PortResult<()> {
                self.background_results.lock().unwrap().push(request);
                Ok(())
            }

            async fn deliver_thread_goal(
                &self,
                request: AgentThreadGoalDeliveryRequest,
            ) -> PortResult<()> {
                self.thread_goals.lock().unwrap().push(request);
                Ok(())
            }
        }

        let ports = Arc::new(FakeAgentRuntimePorts::default());
        let lifecycle = Arc::new(RecordingLifecycleDeliveryPort::default());
        let runtime = AgentRuntimeBuilder::new()
            .with_submission_port(ports)
            .with_lifecycle_delivery_port(lifecycle.clone())
            .build()
            .expect("runtime");

        runtime
            .deliver_background_result(AgentBackgroundResultRequest {
                session_id: "session_1".to_string(),
                agent_type: "Standard".to_string(),
                workspace_path: Some("/workspace/project".to_string()),
                remote_connection_id: Some("conn-1".to_string()),
                remote_ssh_host: Some("host-1".to_string()),
                content: "result".to_string(),
                display_content: Some("display".to_string()),
                metadata: serde_json::Map::new(),
            })
            .await
            .expect("background result");

        runtime
            .deliver_thread_goal(AgentThreadGoalDeliveryRequest {
                session_id: "session_1".to_string(),
                agent_type: "Standard".to_string(),
                workspace_path: Some("/workspace/project".to_string()),
                remote_connection_id: Some("conn-1".to_string()),
                remote_ssh_host: Some("host-1".to_string()),
                kind: AgentThreadGoalDeliveryKind::Resumed,
                goal: ThreadGoal {
                    goal_id: "goal_1".to_string(),
                    session_id: "session_1".to_string(),
                    objective: "Ship the refactor".to_string(),
                    status: ThreadGoalStatus::Active,
                    token_budget: None,
                    tokens_used: 0,
                    time_used_seconds: 0,
                    created_at: 1,
                    updated_at: 2,
                    auto_continuation_count: 0,
                },
            })
            .await
            .expect("thread goal delivery");

        assert_eq!(lifecycle.background_results.lock().unwrap().len(), 1);
        assert_eq!(
            lifecycle.background_results.lock().unwrap()[0]
                .display_content
                .as_deref(),
            Some("display")
        );
        assert_eq!(
            lifecycle.background_results.lock().unwrap()[0]
                .remote_connection_id
                .as_deref(),
            Some("conn-1")
        );
        assert_eq!(lifecycle.thread_goals.lock().unwrap().len(), 1);
        assert_eq!(
            lifecycle.thread_goals.lock().unwrap()[0].kind,
            AgentThreadGoalDeliveryKind::Resumed
        );
        assert_eq!(
            lifecycle.thread_goals.lock().unwrap()[0]
                .remote_ssh_host
                .as_deref(),
            Some("host-1")
        );
    }

    #[tokio::test]
    async fn publish_event_requires_registered_runtime_services() {
        let ports = Arc::new(FakeAgentRuntimePorts::default());
        let runtime = AgentRuntimeBuilder::new()
            .with_submission_port(ports)
            .build()
            .expect("runtime");

        let err = runtime
            .publish_event(RuntimeEventEnvelope {
                session_id: "session_1".to_string(),
                turn_id: Some("turn_1".to_string()),
                source: Some(AgentSubmissionSource::Cli),
                event_type: RuntimeEventType::TurnStarted,
                payload: serde_json::json!({ "phase": "submitted" }),
            })
            .await
            .unwrap_err();

        assert_eq!(err, RuntimeError::MissingEventSink);
    }

    #[tokio::test]
    async fn publish_event_uses_runtime_services_event_sink() {
        let ports = Arc::new(FakeAgentRuntimePorts::default());
        let events = Arc::new(RecordingRuntimeEventSink::default());
        let services = runtime_services_with_events(events.clone());
        let runtime = AgentRuntimeBuilder::new()
            .with_submission_port(ports)
            .with_services(services)
            .build()
            .expect("runtime");

        let event = RuntimeEventEnvelope {
            session_id: "session_1".to_string(),
            turn_id: Some("turn_1".to_string()),
            source: Some(AgentSubmissionSource::Cli),
            event_type: RuntimeEventType::TurnStarted,
            payload: serde_json::json!({ "phase": "submitted" }),
        };

        runtime
            .publish_event(event.clone())
            .await
            .expect("publish event");

        assert_eq!(events.events(), vec![event]);
    }

    #[tokio::test]
    async fn run_handle_exposes_configured_agent_event_stream() {
        let ports = Arc::new(FakeAgentRuntimePorts::default());
        let events = AgentEventStream::new();
        let runtime = AgentRuntimeBuilder::new()
            .with_submission_port(ports)
            .with_event_stream(events.clone())
            .build()
            .expect("runtime");

        let handle = runtime
            .run(AgentRunRequest::new(
                SessionSelector::existing("session_1"),
                "hello",
            ))
            .await
            .expect("run");

        let handle_events = handle.events.as_ref().expect("event stream");
        assert!(handle_events.is_empty());

        let event = RuntimeEventEnvelope {
            session_id: handle.session_id.clone(),
            turn_id: Some(handle.turn_id.clone()),
            source: Some(AgentSubmissionSource::Cli),
            event_type: RuntimeEventType::TurnStarted,
            payload: serde_json::json!({ "phase": "submitted" }),
        };

        runtime
            .publish_event(event.clone())
            .await
            .expect("publish event");

        assert_eq!(handle_events.snapshot(), vec![event.clone()]);
        assert_eq!(events.drain(), vec![event]);
        assert!(handle_events.is_empty());
    }

    #[tokio::test]
    async fn port_errors_remain_typed() {
        #[derive(Debug)]
        struct FailingSubmissionPort;

        #[async_trait::async_trait]
        impl AgentSubmissionPort for FailingSubmissionPort {
            async fn create_session(
                &self,
                _request: AgentSessionCreateRequest,
            ) -> PortResult<AgentSessionCreateResult> {
                Err(PortError::new(PortErrorKind::Backend, "backend failed"))
            }

            async fn submit_message(
                &self,
                _request: AgentSubmissionRequest,
            ) -> PortResult<AgentSubmissionResult> {
                Err(PortError::new(PortErrorKind::Backend, "backend failed"))
            }

            async fn resolve_session_agent_type(
                &self,
                _session_id: &str,
            ) -> PortResult<Option<String>> {
                Ok(None)
            }
        }

        let runtime = AgentRuntimeBuilder::new()
            .with_submission_port(Arc::new(FailingSubmissionPort))
            .build()
            .expect("runtime");

        let err = runtime
            .run(AgentRunRequest::new(
                SessionSelector::existing("session_1"),
                "hello",
            ))
            .await
            .unwrap_err();

        assert_eq!(
            err,
            RuntimeError::Port(PortError::new(PortErrorKind::Backend, "backend failed"))
        );
    }
}
