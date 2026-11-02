//! Narrow Agent Runtime SDK facade.
//!
//! This module is the stable entrypoint for embedding the portable agent
//! runtime with caller-provided ports. Concrete product assembly remains
//! outside this crate. The SDK facade exposes stable agent/session/event ports;
//! product assembly owns plugin-client injection through the internal runtime
//! builder, not through this SDK surface.

use std::sync::Arc;

pub const AGENT_RUNTIME_SDK_API_VERSION: u32 = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum AgentRuntimeSdkStability {
    Preview,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub struct AgentRuntimeSdkCompatibility {
    pub api_version: u32,
    pub crate_version: &'static str,
    pub stability: AgentRuntimeSdkStability,
}

impl AgentRuntimeSdkCompatibility {
    pub const fn current() -> Self {
        Self {
            api_version: AGENT_RUNTIME_SDK_API_VERSION,
            crate_version: env!("CARGO_PKG_VERSION"),
            stability: AgentRuntimeSdkStability::Preview,
        }
    }
}

pub use crate::context_profile::{ContextProfile, ContextProfilePolicy, ModelCapabilityProfile};
pub use crate::dialog_turn::TurnTokenUsage;
pub use crate::event_source::{AgentEventReceiver, AgentEventSource, AgentSessionEventReceiver};
pub use crate::permission::{
    PermissionReplyResolution, PermissionRequestEventReceiver, PermissionRequestManager,
    PermissionRequestManagerError, PermissionRequestSnapshot, AUTO_APPROVE_ASK_CONTEXT_KEY,
};
pub use crate::post_call_hooks::{
    RuntimeHookErrorPolicy, RuntimeHookKind, RuntimeHookPlan, RuntimeHookRegistry,
    RuntimeHookRegistryBuildError,
};
pub use crate::runtime::{
    attach_session_event_cursor, SessionEventBackfill, SessionEventCursor, SessionEventJournal,
    SessionEventProjectionSnapshot, SessionEventProjectionStore, StoredSessionEvents,
    RUNTIME_EVENT_CURSOR_KEY, RUNTIME_EVENT_STREAM_ID_KEY,
};
pub use crate::runtime::{
    AgentEventStream, AgentRunHandle, AgentRunRequest, AgentSessionRestorePort,
    AgentSessionRestoreRequest, AgentSessionRestoreResult, RuntimeAgentRegistry,
    RuntimeAgentRegistryQuery, RuntimeBuildError, RuntimeError, RuntimeToolRegistry,
    SessionInteractionSnapshot, SessionSelector,
};
pub use crate::session_state::{session_state_label_for_state, ProcessingPhase, SessionState};
pub use crate::user_questions::{PendingUserQuestion, PendingUserQuestionSnapshot};
pub use openbitfun_agent_tools::{ToolRegistry, ToolRegistryItem};
pub use openbitfun_core_types::SessionUsageReport;
// Event envelope types re-exported so protocol surfaces (e.g. `openbitfun-app-server`)
// can carry the runtime event stream over a JSON-RPC transport without depending
// on `openbitfun-events` directly. These are the exact types the runtime's event
// subscribers receive; the app-server forwards them as `agent/event` notifications.
pub use openbitfun_events::{AgenticEvent, AgenticEventEnvelope};
pub use openbitfun_runtime_ports::{
    AgentBackgroundResultRequest, AgentContextReloadPort, AgentDialogSteerRequest,
    AgentDialogTurnExecution, AgentDialogTurnPort, AgentDialogTurnRecoveryOutcome,
    AgentDialogTurnRecoveryRequest, AgentDialogTurnRequest, AgentInputAttachment,
    AgentInteractionResponsePort, AgentLifecycleDeliveryPort, AgentLocalCommandTurnPort,
    AgentLocalCommandTurnRecordRequest, AgentLocalCommandTurnRecordResult,
    AgentMessageWorkspaceReferencesRequest, AgentModeCatalogEntry, AgentModeCatalogPort,
    AgentModeCatalogQuery, AgentSessionArchiveRequest, AgentSessionArchiveStateRequest,
    AgentSessionClosePort, AgentSessionCompactionPort, AgentSessionCompactionRequest,
    AgentSessionCompactionResult, AgentSessionComposerUpdate, AgentSessionCreateRequest,
    AgentSessionCreateResult, AgentSessionDeleteRequest, AgentSessionForkAtTurnRequest,
    AgentSessionForkBeforeTurnRequest, AgentSessionForkPort, AgentSessionForkRequest,
    AgentSessionForkResult, AgentSessionLifecycleStatus, AgentSessionLineageCancellationRequest,
    AgentSessionLineageEntry, AgentSessionLineageInspection, AgentSessionLineagePort,
    AgentSessionLineageRequest, AgentSessionLineageSnapshot, AgentSessionLineageTranscriptRequest,
    AgentSessionListRequest, AgentSessionManagementPort, AgentSessionModePort,
    AgentSessionModeUpdateRequest, AgentSessionModelPort, AgentSessionModelSelection,
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
    AgentTurnSettlementStatus, AgentUserAnswersRequest, AgentUserShellCommandPort,
    AgentUserShellCommandRequest, AgentUserShellCommandResult, AgentWorkspaceReference,
    AgentWorkspaceReferenceKind, AgentWorkspaceReferencePort, AgentWorkspaceReferenceSearchEntry,
    AgentWorkspaceReferenceSearchRequest, AgentWorkspaceReferenceSearchResult,
    AgentWorkspaceReferenceSourceRange, ClockPort, DialogSteerOutcome, DialogSubmissionPolicy,
    DialogSubmitOutcome, FileSystemPort, GitPort, McpCatalogPort, NetworkPort,
    PermissionAuditRecord, PermissionDelegationContext, PermissionGrant, PermissionGrantKey,
    PermissionReply, PermissionReplySource, PermissionRequest, PermissionRequestEvent,
    PermissionRequestSource, PermissionRequestSourceKind, PortError, PortErrorKind, PortResult,
    RemoteAssistantWorkspaceFacts, RemoteCapabilityPort, RemoteConnectionPort,
    RemoteProjectionPort, RemoteRecentWorkspaceFacts, RemoteWorkspaceFacts,
    RemoteWorkspaceFileRuntimeHost, RemoteWorkspaceKind, RemoteWorkspacePort,
    RemoteWorkspaceRuntimeHost, RemoteWorkspaceUpdate, RuntimeEventEnvelope, RuntimeEventSink,
    RuntimeEventType, RuntimeServiceCapability, RuntimeServicePort, SessionStorageKind,
    SessionStoragePathRequest, SessionStoragePathResolution, SessionStorePort, SessionTranscript,
    SessionTranscriptReader, SessionTranscriptRequest, TerminalPort, ThreadGoal, ThreadGoalStatus,
    TranscriptContent, TranscriptMessage, TranscriptToolCall, WorkspaceDiffContent,
    WorkspaceDiffFile, WorkspaceDiffFileStatus, WorkspaceDiffSnapshot, WorkspacePort,
};
pub use openbitfun_runtime_services::{
    CapabilityAvailability, RuntimeServices, RuntimeServicesBuilder, RuntimeServicesError,
    RuntimeServicesProvider, RuntimeServicesRegistry,
};

#[derive(Clone)]
pub struct AgentRuntime {
    inner: crate::runtime::AgentRuntime,
}

impl std::fmt::Debug for AgentRuntime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AgentRuntime").finish_non_exhaustive()
    }
}

#[derive(Default, Clone)]
pub struct AgentRuntimeBuilder {
    inner: crate::runtime::AgentRuntimeBuilder,
}

impl AgentRuntimeBuilder {
    pub fn new() -> Self {
        Self {
            inner: crate::runtime::AgentRuntimeBuilder::new(),
        }
    }

    pub fn with_submission_port(mut self, port: Arc<dyn AgentSubmissionPort>) -> Self {
        self.inner = self.inner.with_submission_port(port);
        self
    }

    pub fn with_session_management_port(
        mut self,
        port: Arc<dyn AgentSessionManagementPort>,
    ) -> Self {
        self.inner = self.inner.with_session_management_port(port);
        self
    }

    pub fn with_session_lineage_port(mut self, port: Arc<dyn AgentSessionLineagePort>) -> Self {
        self.inner = self.inner.with_session_lineage_port(port);
        self
    }

    pub fn with_workspace_reference_port(
        mut self,
        port: Arc<dyn AgentWorkspaceReferencePort>,
    ) -> Self {
        self.inner = self.inner.with_workspace_reference_port(port);
        self
    }

    pub fn with_session_close_port(mut self, port: Arc<dyn AgentSessionClosePort>) -> Self {
        self.inner = self.inner.with_session_close_port(port);
        self
    }

    pub fn with_session_model_port(mut self, port: Arc<dyn AgentSessionModelPort>) -> Self {
        self.inner = self.inner.with_session_model_port(port);
        self
    }

    pub fn with_session_mode_port(mut self, port: Arc<dyn AgentSessionModePort>) -> Self {
        self.inner = self.inner.with_session_mode_port(port);
        self
    }

    pub fn with_session_compaction_port(
        mut self,
        port: Arc<dyn AgentSessionCompactionPort>,
    ) -> Self {
        self.inner = self.inner.with_session_compaction_port(port);
        self
    }

    pub fn with_session_revert_port(mut self, port: Arc<dyn AgentSessionRevertPort>) -> Self {
        self.inner = self.inner.with_session_revert_port(port);
        self
    }

    pub fn with_session_fork_port(mut self, port: Arc<dyn AgentSessionForkPort>) -> Self {
        self.inner = self.inner.with_session_fork_port(port);
        self
    }

    pub fn with_session_usage_port(mut self, port: Arc<dyn AgentSessionUsagePort>) -> Self {
        self.inner = self.inner.with_session_usage_port(port);
        self
    }

    pub fn with_turn_settlement_port(mut self, port: Arc<dyn AgentTurnSettlementPort>) -> Self {
        self.inner = self.inner.with_turn_settlement_port(port);
        self
    }

    pub fn with_session_restore_port(mut self, port: Arc<dyn AgentSessionRestorePort>) -> Self {
        self.inner = self.inner.with_session_restore_port(port);
        self
    }

    pub fn with_local_command_turn_port(
        mut self,
        port: Arc<dyn AgentLocalCommandTurnPort>,
    ) -> Self {
        self.inner = self.inner.with_local_command_turn_port(port);
        self
    }

    pub fn with_user_shell_command_port(
        mut self,
        port: Arc<dyn AgentUserShellCommandPort>,
    ) -> Self {
        self.inner = self.inner.with_user_shell_command_port(port);
        self
    }

    pub fn with_session_transcript_reader(
        mut self,
        reader: Arc<dyn SessionTranscriptReader>,
    ) -> Self {
        self.inner = self.inner.with_session_transcript_reader(reader);
        self
    }

    pub fn with_thread_goal_management_port(
        mut self,
        port: Arc<dyn AgentThreadGoalManagementPort>,
    ) -> Self {
        self.inner = self.inner.with_thread_goal_management_port(port);
        self
    }

    pub fn with_dialog_turn_port(mut self, port: Arc<dyn AgentDialogTurnPort>) -> Self {
        self.inner = self.inner.with_dialog_turn_port(port);
        self
    }

    pub fn with_lifecycle_delivery_port(
        mut self,
        port: Arc<dyn AgentLifecycleDeliveryPort>,
    ) -> Self {
        self.inner = self.inner.with_lifecycle_delivery_port(port);
        self
    }

    pub fn with_cancellation_port(mut self, port: Arc<dyn AgentTurnCancellationPort>) -> Self {
        self.inner = self.inner.with_cancellation_port(port);
        self
    }

    pub fn with_interaction_response_port(
        mut self,
        port: Arc<dyn AgentInteractionResponsePort>,
    ) -> Self {
        self.inner = self.inner.with_interaction_response_port(port);
        self
    }

    pub fn with_permission_request_manager(
        mut self,
        manager: Arc<PermissionRequestManager>,
    ) -> Self {
        self.inner = self.inner.with_permission_request_manager(manager);
        self
    }

    pub fn with_services(mut self, services: RuntimeServices) -> Self {
        self.inner = self.inner.with_services(services);
        self
    }

    pub fn with_event_stream(mut self, events: AgentEventStream) -> Self {
        self.inner = self.inner.with_event_stream(events);
        self
    }

    pub fn with_event_source(mut self, source: AgentEventSource) -> Self {
        self.inner = self.inner.with_event_source(source);
        self
    }

    pub fn with_session_event_journal(mut self, journal: Arc<SessionEventJournal>) -> Self {
        self.inner = self.inner.with_session_event_journal(journal);
        self
    }

    pub fn with_tool_registry(mut self, registry: Arc<dyn RuntimeToolRegistry>) -> Self {
        self.inner = self.inner.with_tool_registry(registry);
        self
    }

    pub fn with_hook_registry(mut self, registry: RuntimeHookRegistry) -> Self {
        self.inner = self.inner.with_hook_registry(registry);
        self
    }

    pub fn with_agent_registry(mut self, registry: Arc<dyn RuntimeAgentRegistry>) -> Self {
        self.inner = self.inner.with_agent_registry(registry);
        self
    }

    pub fn with_mode_catalog(mut self, port: Arc<dyn AgentModeCatalogPort>) -> Self {
        self.inner = self.inner.with_mode_catalog(port);
        self
    }

    pub fn build(self) -> Result<AgentRuntime, RuntimeBuildError> {
        self.inner.build().map(|inner| AgentRuntime { inner })
    }
}

impl AgentRuntime {
    pub fn with_session_event_journal(mut self, journal: Arc<SessionEventJournal>) -> Self {
        self.inner = self.inner.with_session_event_journal(journal);
        self
    }

    pub fn subscribe_events(&self) -> Result<AgentEventReceiver, RuntimeError> {
        self.inner.subscribe_events()
    }

    pub fn subscribe_session_events(
        &self,
        session_id: &str,
    ) -> Result<AgentSessionEventReceiver, RuntimeError> {
        self.inner.subscribe_session_events(session_id)
    }

    pub fn pending_permission_requests(&self) -> Result<Vec<PermissionRequest>, RuntimeError> {
        self.inner.pending_permission_requests()
    }

    pub fn permission_request_dialog_turn_id(
        &self,
        request_id: &str,
    ) -> Result<Option<String>, RuntimeError> {
        self.inner.permission_request_dialog_turn_id(request_id)
    }

    pub fn subscribe_permission_requests(
        &self,
    ) -> Result<PermissionRequestEventReceiver, RuntimeError> {
        self.inner.subscribe_permission_requests()
    }

    pub async fn respond_permission(
        &self,
        request_id: &str,
        reply: PermissionReply,
    ) -> Result<(), RuntimeError> {
        self.inner
            .respond_permission(request_id, reply, PermissionReplySource::User)
            .await
    }

    pub async fn respond_permission_with_source(
        &self,
        request_id: &str,
        reply: PermissionReply,
        source: PermissionReplySource,
    ) -> Result<(), RuntimeError> {
        self.inner
            .respond_permission(request_id, reply, source)
            .await
    }

    pub async fn respond_permission_batch(
        &self,
        request_id: &str,
        reply: PermissionReply,
    ) -> Result<Vec<String>, RuntimeError> {
        self.inner
            .respond_permission_batch(request_id, reply, PermissionReplySource::User)
            .await
    }

    pub async fn list_project_permission_grants(
        &self,
        project_id: &str,
    ) -> Result<Vec<PermissionGrant>, RuntimeError> {
        self.inner.list_project_permission_grants(project_id).await
    }

    pub async fn remove_project_permission_grant(
        &self,
        key: PermissionGrantKey,
    ) -> Result<bool, RuntimeError> {
        self.inner.remove_project_permission_grant(key).await
    }

    pub async fn clear_project_permission_grants(
        &self,
        project_id: &str,
    ) -> Result<usize, RuntimeError> {
        self.inner.clear_project_permission_grants(project_id).await
    }

    pub async fn list_project_permission_audit(
        &self,
        project_id: &str,
    ) -> Result<Vec<PermissionAuditRecord>, RuntimeError> {
        self.inner.list_project_permission_audit(project_id).await
    }

    pub fn services(&self) -> Option<&RuntimeServices> {
        self.inner.services()
    }

    pub async fn workspace_diff(&self) -> Result<WorkspaceDiffSnapshot, RuntimeError> {
        self.inner.workspace_diff().await
    }

    pub fn registered_tool_names(&self) -> Vec<String> {
        self.inner.registered_tool_names()
    }

    pub fn hook_registry(&self) -> &RuntimeHookRegistry {
        self.inner.hook_registry()
    }

    pub fn registered_agent_ids(&self, query: RuntimeAgentRegistryQuery<'_>) -> Vec<String> {
        self.inner.registered_agent_ids(query)
    }

    pub async fn list_agent_modes(
        &self,
        query: AgentModeCatalogQuery,
    ) -> Result<Vec<AgentModeCatalogEntry>, RuntimeError> {
        self.inner.list_agent_modes(query).await
    }

    pub async fn create_session(
        &self,
        request: AgentSessionCreateRequest,
    ) -> Result<AgentSessionCreateResult, RuntimeError> {
        self.inner.create_session(request).await
    }

    pub async fn create_session_with_id(
        &self,
        session_id: String,
        request: AgentSessionCreateRequest,
    ) -> Result<AgentSessionCreateResult, RuntimeError> {
        self.inner.create_session_with_id(session_id, request).await
    }

    /// Creates one connection-scoped Session through the same Runtime owners.
    /// It is intentionally separate from durable Session creation so process
    /// adapters cannot silently weaken persistence semantics.
    pub async fn create_transient_session_with_id(
        &self,
        session_id: String,
        request: AgentSessionCreateRequest,
    ) -> Result<AgentSessionCreateResult, RuntimeError> {
        self.inner
            .create_transient_session_with_id(session_id, request)
            .await
    }

    pub async fn discard_transient_session(
        &self,
        request: AgentTransientSessionDiscardRequest,
    ) -> Result<bool, RuntimeError> {
        self.inner.discard_transient_session(request).await
    }

    pub async fn unload_persisted_session(
        &self,
        request: AgentSessionReleaseRequest,
    ) -> Result<bool, RuntimeError> {
        self.inner.unload_persisted_session(request).await
    }

    pub async fn list_sessions(
        &self,
        request: AgentSessionListRequest,
    ) -> Result<Vec<AgentSessionSummary>, RuntimeError> {
        self.inner.list_sessions(request).await
    }

    pub async fn delete_session(
        &self,
        request: AgentSessionDeleteRequest,
    ) -> Result<(), RuntimeError> {
        self.inner.delete_session(request).await
    }

    pub async fn rename_session(
        &self,
        request: AgentSessionRenameRequest,
    ) -> Result<(), RuntimeError> {
        self.inner.rename_session(request).await
    }

    pub async fn archive_session(
        &self,
        request: AgentSessionArchiveRequest,
    ) -> Result<(), RuntimeError> {
        self.inner.archive_session(request).await
    }

    pub async fn set_session_archived(
        &self,
        request: AgentSessionArchiveStateRequest,
    ) -> Result<(), RuntimeError> {
        self.inner.set_session_archived(request).await
    }

    pub async fn record_completed_local_command_turn(
        &self,
        request: AgentLocalCommandTurnRecordRequest,
    ) -> Result<AgentLocalCommandTurnRecordResult, RuntimeError> {
        self.inner
            .record_completed_local_command_turn(request)
            .await
    }

    pub async fn run_user_shell_command(
        &self,
        request: AgentUserShellCommandRequest,
    ) -> Result<AgentUserShellCommandResult, RuntimeError> {
        self.inner.run_user_shell_command(request).await
    }

    pub async fn update_session_model(
        &self,
        request: AgentSessionModelUpdateRequest,
    ) -> Result<(), RuntimeError> {
        self.inner.update_session_model(request).await
    }

    pub async fn update_session_model_target(
        &self,
        session_id: &str,
        selection: openbitfun_core_types::model_pool::ModelSelection,
    ) -> Result<openbitfun_core_types::model_pool::SessionModelTarget, RuntimeError> {
        self.inner
            .update_session_model_target(session_id, selection)
            .await
    }

    pub async fn get_session_model_target(
        &self,
        session_id: &str,
    ) -> Result<openbitfun_core_types::model_pool::SessionModelTarget, RuntimeError> {
        self.inner.get_session_model_target(session_id).await
    }

    pub async fn update_session_model_selection(
        &self,
        request: AgentSessionModelSelectionUpdateRequest,
    ) -> Result<(), RuntimeError> {
        self.inner.update_session_model_selection(request).await
    }

    pub async fn update_session_mode(
        &self,
        request: AgentSessionModeUpdateRequest,
    ) -> Result<(), RuntimeError> {
        self.inner.update_session_mode(request).await
    }

    pub async fn start_session_compaction(
        &self,
        request: AgentSessionCompactionRequest,
    ) -> Result<AgentSessionCompactionResult, RuntimeError> {
        self.inner.start_session_compaction(request).await
    }

    pub async fn undo_session(
        &self,
        request: AgentSessionRevertRequest,
    ) -> Result<AgentSessionRevertResult, RuntimeError> {
        self.inner.undo_session(request).await
    }

    pub async fn redo_session(
        &self,
        request: AgentSessionRevertRequest,
    ) -> Result<AgentSessionRevertResult, RuntimeError> {
        self.inner.redo_session(request).await
    }

    pub async fn rollback_session_to_turn(
        &self,
        request: AgentSessionRollbackToTurnRequest,
    ) -> Result<AgentSessionRollbackToTurnOutcome, RuntimeError> {
        self.inner.rollback_session_to_turn(request).await
    }

    pub async fn fork_session(
        &self,
        request: AgentSessionForkRequest,
    ) -> Result<AgentSessionForkResult, RuntimeError> {
        self.inner.fork_session(request).await
    }

    pub async fn fork_session_at_turn(
        &self,
        request: AgentSessionForkAtTurnRequest,
    ) -> Result<AgentSessionForkResult, RuntimeError> {
        self.inner.fork_session_at_turn(request).await
    }

    pub async fn fork_session_before_turn(
        &self,
        request: AgentSessionForkBeforeTurnRequest,
    ) -> Result<AgentSessionForkResult, RuntimeError> {
        self.inner.fork_session_before_turn(request).await
    }

    pub async fn generate_session_usage(
        &self,
        request: AgentSessionUsageRequest,
    ) -> Result<SessionUsageReport, RuntimeError> {
        self.inner.generate_session_usage(request).await
    }

    pub async fn wait_for_turn_settlement(
        &self,
        request: AgentTurnSettlementRequest,
    ) -> Result<AgentTurnSettlementResult, RuntimeError> {
        self.inner.wait_for_turn_settlement(request).await
    }

    pub async fn restore_session(
        &self,
        request: AgentSessionRestoreRequest,
    ) -> Result<AgentSessionRestoreResult, RuntimeError> {
        self.inner.restore_session(request).await
    }

    pub async fn read_session_transcript(
        &self,
        request: SessionTranscriptRequest,
    ) -> Result<SessionTranscript, RuntimeError> {
        self.inner.read_session_transcript(request).await
    }

    pub async fn get_session_lineage(
        &self,
        request: AgentSessionLineageRequest,
    ) -> Result<Option<AgentSessionLineageSnapshot>, RuntimeError> {
        self.inner.get_session_lineage(request).await
    }

    pub async fn read_lineage_session_transcript(
        &self,
        request: AgentSessionLineageTranscriptRequest,
    ) -> Result<AgentSessionLineageInspection, RuntimeError> {
        self.inner.read_lineage_session_transcript(request).await
    }

    pub async fn resolve_session_workspace_binding(
        &self,
        request: AgentSessionWorkspaceRequest,
    ) -> Result<Option<AgentSessionWorkspaceBinding>, RuntimeError> {
        self.inner.resolve_session_workspace_binding(request).await
    }

    pub async fn search_workspace_references(
        &self,
        request: AgentWorkspaceReferenceSearchRequest,
    ) -> Result<AgentWorkspaceReferenceSearchResult, RuntimeError> {
        self.inner.search_workspace_references(request).await
    }

    pub async fn workspace_references_for_message(
        &self,
        request: AgentMessageWorkspaceReferencesRequest,
    ) -> Result<Vec<AgentWorkspaceReference>, RuntimeError> {
        self.inner.workspace_references_for_message(request).await
    }

    pub async fn submit_turn(
        &self,
        request: AgentSubmissionRequest,
    ) -> Result<AgentSubmissionResult, RuntimeError> {
        self.inner.submit_turn(request).await
    }

    pub async fn manage_dialog_queue(
        &self,
        request: openbitfun_runtime_ports::DialogQueueRequest,
    ) -> Result<openbitfun_runtime_ports::DialogQueueSnapshot, RuntimeError> {
        self.inner.manage_dialog_queue(request).await
    }

    pub async fn submit_dialog_turn(
        &self,
        request: AgentDialogTurnRequest,
    ) -> Result<DialogSubmitOutcome, RuntimeError> {
        self.inner.submit_dialog_turn(request).await
    }

    pub async fn steer_dialog_turn(
        &self,
        request: AgentDialogSteerRequest,
    ) -> Result<DialogSteerOutcome, RuntimeError> {
        self.inner.steer_dialog_turn(request).await
    }

    pub async fn recover_interrupted_turn(
        &self,
        request: AgentDialogTurnRecoveryRequest,
    ) -> Result<AgentDialogTurnRecoveryOutcome, RuntimeError> {
        self.inner.recover_interrupted_turn(request).await
    }

    pub async fn deliver_background_result(
        &self,
        request: AgentBackgroundResultRequest,
    ) -> Result<(), RuntimeError> {
        self.inner.deliver_background_result(request).await
    }

    pub async fn deliver_thread_goal(
        &self,
        request: AgentThreadGoalDeliveryRequest,
    ) -> Result<(), RuntimeError> {
        self.inner.deliver_thread_goal(request).await
    }

    pub async fn get_thread_goal(
        &self,
        request: AgentThreadGoalGetRequest,
    ) -> Result<Option<ThreadGoal>, RuntimeError> {
        self.inner.get_thread_goal(request).await
    }

    pub async fn create_thread_goal(
        &self,
        request: AgentThreadGoalCreateRequest,
    ) -> Result<ThreadGoal, RuntimeError> {
        self.inner.create_thread_goal(request).await
    }

    pub async fn update_thread_goal_status(
        &self,
        request: AgentThreadGoalUpdateStatusRequest,
    ) -> Result<ThreadGoal, RuntimeError> {
        self.inner.update_thread_goal_status(request).await
    }

    pub async fn resolve_session_agent_type(
        &self,
        session_id: &str,
    ) -> Result<Option<String>, RuntimeError> {
        self.inner.resolve_session_agent_type(session_id).await
    }

    pub async fn cancel_turn(
        &self,
        request: AgentTurnCancellationRequest,
    ) -> Result<AgentTurnCancellationResult, RuntimeError> {
        self.inner.cancel_turn(request).await
    }

    pub async fn interrupt_turn(
        &self,
        request: AgentTurnInterruptionRequest,
    ) -> Result<AgentTurnInterruptionResult, RuntimeError> {
        self.inner.interrupt_turn(request).await
    }

    pub async fn cancel_lineage_session(
        &self,
        request: AgentSessionLineageCancellationRequest,
    ) -> Result<AgentTurnCancellationResult, RuntimeError> {
        self.inner.cancel_lineage_session(request).await
    }

    pub async fn submit_user_answers(
        &self,
        request: AgentUserAnswersRequest,
    ) -> Result<(), RuntimeError> {
        self.inner.submit_user_answers(request).await
    }

    pub fn cancel_user_question(
        &self,
        session_id: &str,
        tool_id: &str,
    ) -> Result<(), crate::user_questions::UserInputSendError> {
        self.inner.cancel_user_question(session_id, tool_id)
    }

    pub fn start_user_question_interaction(
        &self,
        session_id: &str,
        tool_id: &str,
    ) -> Result<(), crate::user_questions::UserInputSendError> {
        self.inner
            .start_user_question_interaction(session_id, tool_id)
    }

    pub fn session_interaction_snapshot(&self, session_id: &str) -> SessionInteractionSnapshot {
        self.inner.session_interaction_snapshot(session_id)
    }

    pub fn session_event_projection_snapshot(
        &self,
        session_id: &str,
    ) -> Option<SessionEventProjectionSnapshot> {
        self.inner.session_event_projection_snapshot(session_id)
    }

    pub fn session_events_since(
        &self,
        session_id: &str,
        stream_id: &str,
        cursor: u64,
    ) -> Option<SessionEventBackfill> {
        self.inner
            .session_events_since(session_id, stream_id, cursor)
    }

    pub async fn publish_event(&self, event: RuntimeEventEnvelope) -> Result<(), RuntimeError> {
        self.inner.publish_event(event).await
    }

    pub async fn run(&self, request: AgentRunRequest) -> Result<AgentRunHandle, RuntimeError> {
        self.inner.run(request).await
    }
}
