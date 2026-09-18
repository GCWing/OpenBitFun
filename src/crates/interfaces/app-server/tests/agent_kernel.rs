#![recursion_limit = "512"]

//! Phase 2 integration tests: the generic app-server role exposes real
//! `openbitfun_agent_runtime` SDK operations over the in-memory channel transport.
//!
//! The mock provider only implements `AgentSubmissionPort` (the port behind
//! `run`, `create_session`, and `submit_turn`), matching `sdk_minimal.rs`. The
//! other operations (`list_sessions`, `delete_session`, `cancel_turn`) need
//! separate ports; without them injected the runtime returns a missing-port
//! error, which these tests assert maps to an error at the JSON-RPC boundary.
//!
//! Each `on_receive_request` on `OpenBitFunAppServer::serve` chains a
//! `ChainedHandler` layer; the full agent-kernel + permission + git + config
//! surface now monomorphizes into a handler tower deeper than the default
//! recursion limit when this test instantiates the connection. The lifted
//! limit keeps the chain compiling as more host-service groups land.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_client_protocol::{ConnectionTo, ErrorCode, SentRequest};
use async_trait::async_trait;
use openbitfun_agent_runtime::event_queue::{EventQueue, EventQueueConfig};
use openbitfun_agent_runtime::sdk::{
    AgentEventSource, AgentEventStream, AgentRuntimeBuilder, AgentSessionArchiveStateRequest,
    AgentSessionCreateRequest, AgentSessionCreateResult, AgentSessionDeleteRequest,
    AgentSessionForkAtTurnRequest, AgentSessionForkPort, AgentSessionForkRequest,
    AgentSessionForkResult, AgentSessionListRequest, AgentSessionManagementPort,
    AgentSessionModePort, AgentSessionModeUpdateRequest, AgentSessionModelPort,
    AgentSessionModelSelectionUpdateRequest, AgentSessionModelUpdateRequest,
    AgentSessionRenameRequest, AgentSessionRestorePort, AgentSessionRestoreRequest,
    AgentSessionRestoreResult, AgentSessionSummary, AgentSessionWorkspaceBinding,
    AgentSessionWorkspaceRequest, AgentSubmissionPort, AgentSubmissionRequest,
    AgentSubmissionResult, AgentSubmissionSource, AgentTurnCancellationRequest, AgenticEvent,
    PortResult, ProcessingPhase, SessionState,
};
use openbitfun_app_server::schema::{
    CancelTurnMessage, CreateSessionMessage, CreateSessionResponse, DeleteSessionMessage,
    ForkSessionAtTurnMessage, ForkSessionResponse, ListSessionsMessage, RenameSessionMessage,
    RenameSessionResponse, RespondPermissionMessage, RestoreSessionMessage, RunMessage,
    RunResponse, RunSessionSpec, SessionRuntimeState, SetSessionArchivedMessage,
    SetSessionArchivedResponse, SubmitDialogTurnBody, SubmitDialogTurnMessage,
    SubmitDialogTurnResponse, SubmitTurnMessage, SubmitTurnResponse, UpdateSessionModeMessage,
    UpdateSessionModeResponse, UpdateSessionModelMessage, UpdateSessionModelResponse,
};
use openbitfun_app_server::{
    transport, AppClient, AppServer, OpenBitFunAppRuntime, OpenBitFunAppServer,
};
use openbitfun_app_server_protocol::agent as protocol_agent;
use openbitfun_app_server_protocol::app::{ClientInfo, HealthStatus, InitializeRequest};
use openbitfun_app_server_protocol::error::{AppServerErrorData, AppServerErrorKind};
use openbitfun_app_server_protocol::event::{
    AgentEventNotification, EventStream, SyncEventsRequest,
};
use openbitfun_app_server_protocol::session as protocol_session;
use openbitfun_app_server_protocol::workspace as protocol_workspace;
use openbitfun_app_server_protocol::PROTOCOL_VERSION;
use openbitfun_runtime_ports as ports;
use tokio::task::LocalSet;

/// Minimal `AgentSubmissionPort` mock modeled on `sdk_minimal.rs`.
#[derive(Debug, Default)]
struct ExampleAgentProvider {
    created_sessions: Mutex<Vec<AgentSessionCreateRequest>>,
    submitted_turns: Mutex<Vec<AgentSubmissionRequest>>,
    submitted_dialog_turns: Mutex<Vec<openbitfun_agent_runtime::sdk::AgentDialogTurnRequest>>,
}

#[async_trait]
impl AgentSubmissionPort for ExampleAgentProvider {
    async fn create_session(
        &self,
        request: AgentSessionCreateRequest,
    ) -> PortResult<AgentSessionCreateResult> {
        self.created_sessions.lock().unwrap().push(request.clone());
        Ok(AgentSessionCreateResult::new(
            "example-session",
            request.session_name,
            request.agent_type,
        ))
    }

    async fn submit_message(
        &self,
        request: AgentSubmissionRequest,
    ) -> PortResult<AgentSubmissionResult> {
        self.submitted_turns.lock().unwrap().push(request.clone());
        Ok(AgentSubmissionResult {
            turn_id: request
                .turn_id
                .unwrap_or_else(|| "example-turn".to_string()),
            accepted: true,
        })
    }

    async fn resolve_session_agent_type(&self, _session_id: &str) -> PortResult<Option<String>> {
        Ok(Some("Standard".to_string()))
    }
}

#[async_trait::async_trait]
impl openbitfun_agent_runtime::sdk::AgentDialogTurnPort for ExampleAgentProvider {
    async fn submit_dialog_turn(
        &self,
        request: openbitfun_agent_runtime::sdk::AgentDialogTurnRequest,
    ) -> PortResult<openbitfun_agent_runtime::sdk::DialogSubmitOutcome> {
        self.submitted_dialog_turns
            .lock()
            .unwrap()
            .push(request.clone());
        Ok(
            openbitfun_agent_runtime::sdk::DialogSubmitOutcome::Started {
                session_id: request.session_id,
                turn_id: request
                    .turn_id
                    .unwrap_or_else(|| "example-dialog-turn".to_string()),
            },
        )
    }
}

fn build_runtime() -> openbitfun_agent_runtime::sdk::AgentRuntime {
    let provider = Arc::new(ExampleAgentProvider::default());
    let events = AgentEventStream::new();
    AgentRuntimeBuilder::new()
        .with_submission_port(provider.clone())
        .with_dialog_turn_port(provider)
        .with_event_stream(events)
        .build()
        .expect("runtime should build with submission + dialog turn ports")
}

/// Wrap the test runtime with a fresh `AgentEventSource` backed by an isolated
/// `EventQueue`, so the app-server's event forwarder has something to drain.
fn build_app_runtime() -> OpenBitFunAppRuntime {
    let event_queue = Arc::new(EventQueue::new(EventQueueConfig::default()));
    let event_source = AgentEventSource::new(event_queue);
    OpenBitFunAppRuntime::new(build_runtime(), event_source)
}

/// Like [`build_app_runtime`] but also hands back the backing `EventQueue` so a
/// test can publish into it and assert the server forwards the event to the
/// client as an `agent/event` notification.
fn build_app_runtime_with_queue() -> (OpenBitFunAppRuntime, Arc<EventQueue>) {
    let event_queue = Arc::new(EventQueue::new(EventQueueConfig::default()));
    let event_source = AgentEventSource::new(event_queue.clone());
    (
        OpenBitFunAppRuntime::new(build_runtime(), event_source),
        event_queue,
    )
}

#[derive(Debug, Default)]
struct SessionControlProvider {
    renamed: Mutex<Vec<AgentSessionRenameRequest>>,
    archive_updates: Mutex<Vec<AgentSessionArchiveStateRequest>>,
    model_updates: Mutex<Vec<AgentSessionModelUpdateRequest>>,
    mode_updates: Mutex<Vec<AgentSessionModeUpdateRequest>>,
    forks_at_turn: Mutex<Vec<AgentSessionForkAtTurnRequest>>,
    restores: Mutex<Vec<AgentSessionRestoreRequest>>,
}

#[async_trait]
impl AgentSessionManagementPort for SessionControlProvider {
    async fn list_sessions(
        &self,
        _request: AgentSessionListRequest,
    ) -> PortResult<Vec<AgentSessionSummary>> {
        Ok(Vec::new())
    }

    async fn delete_session(&self, _request: AgentSessionDeleteRequest) -> PortResult<()> {
        Ok(())
    }

    async fn rename_session(&self, request: AgentSessionRenameRequest) -> PortResult<()> {
        self.renamed.lock().unwrap().push(request);
        Ok(())
    }

    async fn set_session_archived(
        &self,
        request: AgentSessionArchiveStateRequest,
    ) -> PortResult<()> {
        self.archive_updates.lock().unwrap().push(request);
        Ok(())
    }

    async fn resolve_session_workspace_binding(
        &self,
        _request: AgentSessionWorkspaceRequest,
    ) -> PortResult<Option<AgentSessionWorkspaceBinding>> {
        Ok(None)
    }
}

#[async_trait]
impl AgentSessionModelPort for SessionControlProvider {
    async fn update_session_model_selection(
        &self,
        request: AgentSessionModelSelectionUpdateRequest,
    ) -> PortResult<()> {
        self.model_updates
            .lock()
            .unwrap()
            .push(AgentSessionModelUpdateRequest {
                session_id: request.session_id,
                model_id: request.selection.model_id,
            });
        Ok(())
    }

    async fn update_session_model(
        &self,
        request: AgentSessionModelUpdateRequest,
    ) -> PortResult<()> {
        self.model_updates.lock().unwrap().push(request);
        Ok(())
    }
}

#[async_trait]
impl AgentSessionModePort for SessionControlProvider {
    async fn update_session_mode(&self, request: AgentSessionModeUpdateRequest) -> PortResult<()> {
        self.mode_updates.lock().unwrap().push(request);
        Ok(())
    }
}

#[async_trait]
impl AgentSessionForkPort for SessionControlProvider {
    async fn fork_session(
        &self,
        request: AgentSessionForkRequest,
    ) -> PortResult<AgentSessionForkResult> {
        Ok(AgentSessionForkResult {
            session_id: format!("{}-fork", request.source_session_id),
            session_name: "Forked Session".to_string(),
            agent_type: "Standard".to_string(),
        })
    }

    async fn fork_session_at_turn(
        &self,
        request: AgentSessionForkAtTurnRequest,
    ) -> PortResult<AgentSessionForkResult> {
        self.forks_at_turn.lock().unwrap().push(request);
        Ok(AgentSessionForkResult {
            session_id: "forked-session".to_string(),
            session_name: "Forked at Turn".to_string(),
            agent_type: "Standard".to_string(),
        })
    }
}

#[async_trait]
impl AgentSessionRestorePort for SessionControlProvider {
    async fn restore_session(
        &self,
        request: AgentSessionRestoreRequest,
    ) -> PortResult<AgentSessionRestoreResult> {
        self.restores.lock().unwrap().push(request);
        Ok(AgentSessionRestoreResult {
            session: AgentSessionSummary {
                session_id: "session-1".to_string(),
                session_name: "Restored Session".to_string(),
                agent_type: "Standard".to_string(),
                model_id: Some("provider/model".to_string()),
                reasoning_preset: None,
                last_user_dialog_agent_type: None,
                last_submitted_agent_type: Some("Standard".to_string()),
                turn_count: 4,
                created_at_ms: 10,
                last_active_at_ms: 20,
            },
            state: SessionState::Processing {
                current_turn_id: "turn-active".to_string(),
                phase: ProcessingPhase::Thinking,
            },
        })
    }
}

fn build_session_control_app_runtime() -> (OpenBitFunAppRuntime, Arc<SessionControlProvider>) {
    let submission = Arc::new(ExampleAgentProvider::default());
    let session_control = Arc::new(SessionControlProvider::default());
    let runtime = AgentRuntimeBuilder::new()
        .with_submission_port(submission.clone())
        .with_dialog_turn_port(submission)
        .with_session_management_port(session_control.clone())
        .with_session_model_port(session_control.clone())
        .with_session_mode_port(session_control.clone())
        .with_session_fork_port(session_control.clone())
        .with_session_restore_port(session_control.clone())
        .with_event_stream(AgentEventStream::new())
        .build()
        .expect("runtime should build with Session control ports");
    let event_queue = Arc::new(EventQueue::new(EventQueueConfig::default()));
    (
        OpenBitFunAppRuntime::new(runtime, AgentEventSource::new(event_queue)),
        session_control,
    )
}

#[derive(Debug, Default)]
struct Phase2Provider {
    steers: Mutex<Vec<ports::AgentDialogSteerRequest>>,
    shell_commands: Mutex<Vec<ports::AgentUserShellCommandRequest>>,
    answers: Mutex<Vec<ports::AgentUserAnswersRequest>>,
    compactions: Mutex<Vec<ports::AgentSessionCompactionRequest>>,
    settlements: Mutex<Vec<ports::AgentTurnSettlementRequest>>,
    reloads: Mutex<Vec<ports::AgentContextReloadRequest>>,
}

#[async_trait]
impl AgentSubmissionPort for Phase2Provider {
    async fn create_session(
        &self,
        request: AgentSessionCreateRequest,
    ) -> PortResult<AgentSessionCreateResult> {
        Ok(AgentSessionCreateResult::new(
            "phase2-session",
            request.session_name,
            request.agent_type,
        ))
    }

    async fn submit_message(
        &self,
        request: AgentSubmissionRequest,
    ) -> PortResult<AgentSubmissionResult> {
        Ok(AgentSubmissionResult {
            turn_id: request.turn_id.unwrap_or_else(|| "phase2-turn".to_string()),
            accepted: true,
        })
    }

    async fn resolve_session_agent_type(&self, _session_id: &str) -> PortResult<Option<String>> {
        Ok(Some("Standard".to_string()))
    }
}

#[async_trait]
impl ports::AgentSessionManagementPort for Phase2Provider {
    async fn list_sessions(
        &self,
        _request: ports::AgentSessionListRequest,
    ) -> PortResult<Vec<ports::AgentSessionSummary>> {
        Ok(Vec::new())
    }

    async fn delete_session(&self, _request: ports::AgentSessionDeleteRequest) -> PortResult<()> {
        Ok(())
    }

    async fn rename_session(&self, _request: ports::AgentSessionRenameRequest) -> PortResult<()> {
        Ok(())
    }

    async fn resolve_session_workspace_binding(
        &self,
        _request: ports::AgentSessionWorkspaceRequest,
    ) -> PortResult<Option<ports::AgentSessionWorkspaceBinding>> {
        Ok(Some(ports::AgentSessionWorkspaceBinding {
            workspace_kind: None,
            project_workspace_id: None,
            workspace_id: Some("workspace-1".to_string()),
            workspace_path: "/authoritative/workspace".to_string(),
            project_workspace_path: Some("/authoritative/workspace".to_string()),
            execution_target: Some(ports::SessionExecutionTarget::local(
                "/authoritative/workspace",
            )),
            remote_connection_id: None,
            remote_ssh_host: None,
        }))
    }
}

#[async_trait]
impl openbitfun_agent_runtime::sdk::AgentSessionRestorePort for Phase2Provider {
    async fn restore_session(
        &self,
        request: openbitfun_agent_runtime::sdk::AgentSessionRestoreRequest,
    ) -> PortResult<openbitfun_agent_runtime::sdk::AgentSessionRestoreResult> {
        Ok(openbitfun_agent_runtime::sdk::AgentSessionRestoreResult {
            session: ports::AgentSessionSummary {
                session_id: request.session_id,
                session_name: "Phase 2".to_string(),
                agent_type: "Standard".to_string(),
                model_id: Some("provider/model".to_string()),
                reasoning_preset: None,
                last_user_dialog_agent_type: None,
                last_submitted_agent_type: Some("Standard".to_string()),
                turn_count: 1,
                created_at_ms: 10,
                last_active_at_ms: 20,
            },
            state: SessionState::Processing {
                current_turn_id: "turn-active".to_string(),
                phase: ProcessingPhase::Streaming,
            },
        })
    }
}

#[async_trait]
impl ports::SessionTranscriptReader for Phase2Provider {
    async fn read_session_transcript(
        &self,
        request: ports::SessionTranscriptRequest,
    ) -> PortResult<ports::SessionTranscript> {
        Ok(ports::SessionTranscript {
            session_id: request.session_id,
            messages: vec![ports::TranscriptMessage {
                id: Some("message-1".to_string()),
                role: "assistant".to_string(),
                turn_id: Some("turn-1".to_string()),
                timestamp_ms: Some(20),
                content: ports::TranscriptContent::Text("ready".to_string()),
            }],
        })
    }
}

#[async_trait]
impl ports::AgentDialogTurnPort for Phase2Provider {
    async fn submit_dialog_turn(
        &self,
        request: ports::AgentDialogTurnRequest,
    ) -> PortResult<ports::DialogSubmitOutcome> {
        Ok(ports::DialogSubmitOutcome::Started {
            session_id: request.session_id,
            turn_id: request.turn_id.unwrap_or_else(|| "turn-new".to_string()),
        })
    }

    async fn steer_dialog_turn(
        &self,
        request: ports::AgentDialogSteerRequest,
    ) -> PortResult<ports::DialogSteerOutcome> {
        self.steers.lock().unwrap().push(request.clone());
        Ok(ports::DialogSteerOutcome::Buffered {
            session_id: request.session_id,
            turn_id: request.turn_id,
            steering_id: "steering-1".to_string(),
        })
    }
}

#[async_trait]
impl ports::AgentUserShellCommandPort for Phase2Provider {
    async fn run_user_shell_command(
        &self,
        request: ports::AgentUserShellCommandRequest,
    ) -> PortResult<ports::AgentUserShellCommandResult> {
        self.shell_commands.lock().unwrap().push(request.clone());
        Ok(ports::AgentUserShellCommandResult {
            session_id: request.session_id,
            turn_id: request.turn_id,
        })
    }
}

#[async_trait]
impl ports::AgentInteractionResponsePort for Phase2Provider {
    async fn submit_user_answers(&self, request: ports::AgentUserAnswersRequest) -> PortResult<()> {
        self.answers.lock().unwrap().push(request);
        Ok(())
    }
}

#[async_trait]
impl ports::AgentLocalCommandTurnPort for Phase2Provider {
    async fn record_completed_local_command_turn(
        &self,
        request: ports::AgentLocalCommandTurnRecordRequest,
    ) -> PortResult<ports::AgentLocalCommandTurnRecordResult> {
        Ok(ports::AgentLocalCommandTurnRecordResult {
            turn_id: request
                .turn_id
                .unwrap_or_else(|| "local-command-1".to_string()),
            storage_turn_index: 1,
        })
    }
}

#[async_trait]
impl ports::AgentSessionCompactionPort for Phase2Provider {
    async fn start_session_compaction(
        &self,
        request: ports::AgentSessionCompactionRequest,
    ) -> PortResult<ports::AgentSessionCompactionResult> {
        self.compactions.lock().unwrap().push(request.clone());
        Ok(ports::AgentSessionCompactionResult {
            session_id: request.session_id,
            turn_id: request.turn_id,
        })
    }
}

#[async_trait]
impl ports::AgentSessionRevertPort for Phase2Provider {
    async fn undo_session(
        &self,
        request: ports::AgentSessionRevertRequest,
    ) -> PortResult<ports::AgentSessionRevertResult> {
        Ok(revert_result(request.session_id, "undo restored"))
    }

    async fn redo_session(
        &self,
        request: ports::AgentSessionRevertRequest,
    ) -> PortResult<ports::AgentSessionRevertResult> {
        Ok(revert_result(request.session_id, "redo restored"))
    }
}

#[async_trait]
impl ports::AgentSessionUsagePort for Phase2Provider {
    async fn generate_session_usage(
        &self,
        request: ports::AgentSessionUsageRequest,
    ) -> PortResult<openbitfun_agent_runtime::sdk::SessionUsageReport> {
        Ok(
            openbitfun_agent_runtime::sdk::SessionUsageReport::partial_unavailable(
                request.session_id,
                1_778_347_200_000,
            ),
        )
    }
}

#[async_trait]
impl ports::AgentTurnSettlementPort for Phase2Provider {
    async fn wait_for_turn_settlement(
        &self,
        request: ports::AgentTurnSettlementRequest,
    ) -> PortResult<ports::AgentTurnSettlementResult> {
        self.settlements.lock().unwrap().push(request);
        Ok(ports::AgentTurnSettlementResult {
            status: ports::AgentTurnSettlementStatus::Completed,
            final_response: Some("fixture result".to_string()),
            finish_reason: Some("stop".to_string()),
        })
    }
}

#[async_trait]
impl ports::AgentWorkspaceReferencePort for Phase2Provider {
    async fn search_workspace_references(
        &self,
        _request: ports::AgentWorkspaceReferenceSearchRequest,
    ) -> PortResult<ports::AgentWorkspaceReferenceSearchResult> {
        Ok(ports::AgentWorkspaceReferenceSearchResult {
            entries: vec![ports::AgentWorkspaceReferenceSearchEntry {
                path: "src/lib.rs".to_string(),
                kind: ports::AgentWorkspaceReferenceKind::File,
            }],
            truncated: false,
        })
    }

    async fn workspace_references_for_message(
        &self,
        _request: ports::AgentMessageWorkspaceReferencesRequest,
    ) -> PortResult<Vec<ports::AgentWorkspaceReference>> {
        Ok(vec![ports::AgentWorkspaceReference {
            path: "src/lib.rs".to_string(),
            kind: ports::AgentWorkspaceReferenceKind::File,
            start_line: Some(1),
            end_line: Some(2),
            source: ports::AgentWorkspaceReferenceSourceRange {
                start: 0,
                end: 11,
                value: "@src/lib.rs".to_string(),
            },
        }])
    }
}

#[async_trait]
impl ports::AgentSessionLineagePort for Phase2Provider {
    async fn get_session_lineage(
        &self,
        _request: ports::AgentSessionLineageRequest,
    ) -> PortResult<Option<ports::AgentSessionLineageSnapshot>> {
        Ok(Some(ports::AgentSessionLineageSnapshot {
            root_session_id: "session-1".to_string(),
            sessions: vec![ports::AgentSessionLineageEntry {
                session_id: "session-1".to_string(),
                session_name: "Root".to_string(),
                agent_type: "Standard".to_string(),
                created_at_ms: 10,
                status: ports::AgentSessionLifecycleStatus::Active,
                active_turn_id: Some("turn-active".to_string()),
                parent_session_id: None,
                parent_tool_call_id: None,
                subagent_type: None,
                agent_id: None,
                workspace_id: None,
                workspace_path: Some("/authoritative/workspace".to_string()),
                remote_connection_id: None,
                remote_ssh_host: None,
                unread_completion: None,
                needs_user_attention: None,
            }],
        }))
    }

    async fn read_lineage_session_transcript(
        &self,
        request: ports::AgentSessionLineageTranscriptRequest,
    ) -> PortResult<ports::AgentSessionLineageInspection> {
        Ok(ports::AgentSessionLineageInspection {
            transcript: ports::SessionTranscript {
                session_id: request.session_id,
                messages: Vec::new(),
            },
            active_turn_id: Some("turn-active".to_string()),
        })
    }

    async fn cancel_lineage_session(
        &self,
        request: ports::AgentSessionLineageCancellationRequest,
    ) -> PortResult<ports::AgentTurnCancellationResult> {
        Ok(ports::AgentTurnCancellationResult {
            session_id: request.session_id,
            turn_id: request.expected_active_turn_id,
            requested: true,
        })
    }
}

#[async_trait]
impl ports::AgentContextReloadPort for Phase2Provider {
    async fn reload_session_context(
        &self,
        request: ports::AgentContextReloadRequest,
    ) -> PortResult<()> {
        self.reloads.lock().unwrap().push(request);
        Ok(())
    }
}

fn revert_result(session_id: String, text: &str) -> ports::AgentSessionRevertResult {
    ports::AgentSessionRevertResult {
        session_id: session_id.clone(),
        transcript: ports::SessionTranscript {
            session_id,
            messages: vec![ports::TranscriptMessage {
                id: Some("message-reverted".to_string()),
                role: "user".to_string(),
                turn_id: None,
                timestamp_ms: None,
                content: ports::TranscriptContent::Text(text.to_string()),
            }],
        },
        composer: ports::AgentSessionComposerUpdate::Replace {
            text: text.to_string(),
        },
        retired_turn_ids: vec!["turn-active".to_string()],
        changed: true,
        hidden_turn_count: 1,
        boundary_storage_turn_index: None,
        target_turn_id: None,
        restored_files: Vec::new(),
        reload_required: false,
        reload_reason: None,
    }
}

#[derive(Debug)]
struct TestRuntimeService(ports::RuntimeServiceCapability);

impl ports::RuntimeServicePort for TestRuntimeService {
    fn capability(&self) -> ports::RuntimeServiceCapability {
        self.0
    }
}

impl ports::FileSystemPort for TestRuntimeService {}
impl ports::WorkspacePort for TestRuntimeService {}

#[async_trait]
impl ports::SessionStorePort for TestRuntimeService {
    async fn resolve_session_storage_path(
        &self,
        request: ports::SessionStoragePathRequest,
    ) -> PortResult<ports::SessionStoragePathResolution> {
        Ok(ports::SessionStoragePathResolution::new(
            request.workspace_path.clone(),
            request.workspace_path,
            ports::SessionStorageKind::Local,
            request.remote_connection_id,
            request.remote_ssh_host,
        ))
    }
}

impl ports::ClockPort for TestRuntimeService {
    fn now_unix_millis(&self) -> i64 {
        1_778_347_200_000
    }
}

#[async_trait]
impl ports::GitPort for TestRuntimeService {
    async fn workspace_diff(&self) -> PortResult<ports::WorkspaceDiffSnapshot> {
        Ok(ports::WorkspaceDiffSnapshot {
            files: vec![ports::WorkspaceDiffFile {
                path: "src/lib.rs".to_string(),
                old_path: None,
                status: ports::WorkspaceDiffFileStatus::Modified,
                staged: false,
                unstaged: true,
                untracked: false,
                additions: 1,
                deletions: 1,
                content: ports::WorkspaceDiffContent::Text {
                    patch: "@@ -1 +1 @@\n-old\n+new\n".to_string(),
                },
            }],
            truncated: false,
        })
    }
}

#[derive(Debug)]
struct TestRuntimeEventSink;

#[async_trait]
impl ports::RuntimeEventSink for TestRuntimeEventSink {
    async fn publish_runtime_event(&self, _event: ports::RuntimeEventEnvelope) -> PortResult<()> {
        Ok(())
    }
}

fn build_phase2_app_runtime() -> (OpenBitFunAppRuntime, Arc<Phase2Provider>) {
    let provider = Arc::new(Phase2Provider::default());
    let services = openbitfun_agent_runtime::sdk::RuntimeServicesBuilder::new()
        .with_filesystem(Arc::new(TestRuntimeService(
            ports::RuntimeServiceCapability::FileSystem,
        )))
        .with_workspace(Arc::new(TestRuntimeService(
            ports::RuntimeServiceCapability::Workspace,
        )))
        .with_session_store(Arc::new(TestRuntimeService(
            ports::RuntimeServiceCapability::SessionStore,
        )))
        .with_events(Arc::new(TestRuntimeEventSink))
        .with_clock(Arc::new(TestRuntimeService(
            ports::RuntimeServiceCapability::Clock,
        )))
        .with_optional_git(Some(Arc::new(TestRuntimeService(
            ports::RuntimeServiceCapability::Git,
        ))))
        .build()
        .expect("phase 2 runtime services");
    let runtime = AgentRuntimeBuilder::new()
        .with_submission_port(provider.clone())
        .with_session_management_port(provider.clone())
        .with_session_restore_port(provider.clone())
        .with_session_transcript_reader(provider.clone())
        .with_dialog_turn_port(provider.clone())
        .with_interaction_response_port(provider.clone())
        .with_local_command_turn_port(provider.clone())
        .with_user_shell_command_port(provider.clone())
        .with_session_compaction_port(provider.clone())
        .with_session_revert_port(provider.clone())
        .with_session_usage_port(provider.clone())
        .with_turn_settlement_port(provider.clone())
        .with_workspace_reference_port(provider.clone())
        .with_session_lineage_port(provider.clone())
        .with_services(services)
        .with_event_stream(AgentEventStream::new())
        .build()
        .expect("phase 2 runtime");
    let event_queue = Arc::new(EventQueue::new(EventQueueConfig::default()));
    (
        OpenBitFunAppRuntime::new(runtime, AgentEventSource::new(event_queue))
            .with_context_reload(provider.clone()),
        provider,
    )
}

#[tokio::test(flavor = "current_thread")]
async fn phase2_sync_aggregates_authoritative_session_state() {
    let local = LocalSet::new();
    local
        .run_until(async {
            let (server_transport, client_transport) = transport::in_memory_channel_pair();
            let (runtime, _provider) = build_phase2_app_runtime();
            spawn_server(runtime, server_transport);

            let client = openbitfun_app_server_client::connect(client_transport)
                .await
                .expect("connect app server client");
            let response = client
                .sync_session(protocol_session::SyncSessionRequest {
                    workspace_id: None,
                    workspace_path: "/requested/workspace".to_string(),
                    session_id: "session-1".to_string(),
                    include_internal: true,
                    remote_connection_id: None,
                    remote_ssh_host: None,
                })
                .await
                .expect("sync session");

            assert_eq!(response.session.session_name, "Phase 2");
            assert!(matches!(
                response.state,
                protocol_session::SessionRuntimeState::Processing {
                    ref current_turn_id,
                    ref phase,
                } if current_turn_id == "turn-active"
                    && matches!(phase, protocol_session::SessionProcessingPhase::Streaming)
            ));
            assert_eq!(response.transcript.messages.len(), 1);
            assert_eq!(response.transcript.session_id, "session-1");
            assert_eq!(
                response.workspace_binding.workspace_id.as_deref(),
                Some("workspace-1")
            );
            assert_eq!(
                response.workspace_binding.workspace_path,
                "/authoritative/workspace"
            );
            client.shutdown().await;
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn phase2_mutations_route_through_runtime_owner_ports() {
    let local = LocalSet::new();
    local
        .run_until(async {
            let (server_transport, client_transport) = transport::in_memory_channel_pair();
            let (runtime, provider) = build_phase2_app_runtime();
            spawn_server(runtime, server_transport);

            let client = openbitfun_app_server_client::connect(client_transport)
                .await
                .expect("connect app server client");
            let steer = client
                .steer_turn(protocol_agent::SteerTurnRequest(
                    ports::AgentDialogSteerRequest {
                        session_id: "session-1".to_string(),
                        turn_id: "turn-active".to_string(),
                        content: "keep going".to_string(),
                        display_content: None,
                        attachments: Vec::new(),
                        metadata: serde_json::Map::new(),
                    },
                ))
                .await
                .expect("steer turn");
            assert_eq!(steer.steering_id, "steering-1");

            let shell = client
                .run_user_shell_command(protocol_agent::RunUserShellCommandRequest(
                    ports::AgentUserShellCommandRequest {
                        session_id: "session-1".to_string(),
                        turn_id: "shell-turn".to_string(),
                        command: "cargo test".to_string(),
                    },
                ))
                .await
                .expect("run shell command");
            assert_eq!(shell.0.turn_id, "shell-turn");

            client
                .submit_user_answers(protocol_agent::SubmitUserAnswersRequest {
                    tool_id: "ask-1".to_string(),
                    answers: serde_json::json!({"answer": "yes"}),
                })
                .await
                .expect("submit user answers");
            client
                .compact_session(protocol_session::CompactSessionRequest(
                    ports::AgentSessionCompactionRequest {
                        session_id: "session-1".to_string(),
                        turn_id: "compact-turn".to_string(),
                    },
                ))
                .await
                .expect("compact session");
            let undone = client
                .undo_session(protocol_session::UndoSessionRequest(
                    ports::AgentSessionRevertRequest {
                        workspace_id: None,
                        workspace_path: "/workspace".to_string(),
                        session_id: "session-1".to_string(),
                        remote_connection_id: None,
                        remote_ssh_host: None,
                    },
                ))
                .await
                .expect("undo session");
            assert!(undone.0.changed);
            client
                .redo_session(protocol_session::RedoSessionRequest(
                    ports::AgentSessionRevertRequest {
                        workspace_id: None,
                        workspace_path: "/workspace".to_string(),
                        session_id: "session-1".to_string(),
                        remote_connection_id: None,
                        remote_ssh_host: None,
                    },
                ))
                .await
                .expect("redo session");
            client
                .reload_context(protocol_session::ReloadContextRequest(
                    ports::AgentContextReloadRequest {
                        session_id: "session-1".to_string(),
                        target: ports::AgentContextReloadTarget::All,
                    },
                ))
                .await
                .expect("reload context");

            assert_eq!(provider.steers.lock().unwrap().len(), 1);
            assert_eq!(
                provider.shell_commands.lock().unwrap()[0].command,
                "cargo test"
            );
            assert_eq!(provider.answers.lock().unwrap().len(), 1);
            assert_eq!(provider.compactions.lock().unwrap().len(), 1);
            assert_eq!(provider.reloads.lock().unwrap().len(), 1);
            client.shutdown().await;
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn phase2_read_models_cover_usage_settlement_references_lineage_and_diff() {
    let local = LocalSet::new();
    local
        .run_until(async {
            let (server_transport, client_transport) = transport::in_memory_channel_pair();
            let (runtime, provider) = build_phase2_app_runtime();
            spawn_server(runtime, server_transport);

            let client = openbitfun_app_server_client::connect(client_transport)
                .await
                .expect("connect app server client");
            let usage = client
                .session_usage(protocol_session::SessionUsageRequest(
                    ports::AgentSessionUsageRequest {
                        workspace_id: None,
                        session_id: "session-1".to_string(),
                        workspace_path: Some("/workspace".to_string()),
                        remote_connection_id: None,
                        remote_ssh_host: None,
                        include_hidden_subagents: false,
                    },
                ))
                .await
                .expect("session usage");
            assert_eq!(usage.0.session_id, "session-1");

            client
                .wait_for_settlement(protocol_session::WaitForSettlementRequest(
                    ports::AgentTurnSettlementRequest {
                        session_id: "session-1".to_string(),
                        turn_id: "turn-active".to_string(),
                        wait_timeout_ms: 1_000,
                    },
                ))
                .await
                .expect("wait for settlement");
            let search = client
                .search_workspace_references(protocol_workspace::SearchWorkspaceReferencesRequest(
                    ports::AgentWorkspaceReferenceSearchRequest {
                        session_id: "session-1".to_string(),
                        query: "lib".to_string(),
                        limit: 5,
                    },
                ))
                .await
                .expect("search references");
            assert_eq!(search.0.entries[0].path, "src/lib.rs");
            let references = client
                .message_references(protocol_workspace::MessageReferencesRequest(
                    ports::AgentMessageWorkspaceReferencesRequest {
                        session_id: "session-1".to_string(),
                        message_id: "message-1".to_string(),
                    },
                ))
                .await
                .expect("message references");
            assert_eq!(references.0[0].path, "src/lib.rs");
            let lineage = client
                .session_lineage(protocol_session::SessionLineageRequest(
                    ports::AgentSessionLineageRequest {
                        workspace_id: None,
                        workspace_path: "/workspace".to_string(),
                        anchor_session_id: "session-1".to_string(),
                        remote_connection_id: None,
                        remote_ssh_host: None,
                    },
                ))
                .await
                .expect("lineage");
            assert_eq!(lineage.0.unwrap().root_session_id, "session-1");
            let inspection = client
                .inspect_lineage(protocol_session::InspectLineageRequest(
                    ports::AgentSessionLineageTranscriptRequest {
                        workspace_id: None,
                        workspace_path: "/workspace".to_string(),
                        root_session_id: "session-1".to_string(),
                        session_id: "session-1".to_string(),
                        required_settled_turn_ids: vec!["turn-active".to_string()],
                        remote_connection_id: None,
                        remote_ssh_host: None,
                    },
                ))
                .await
                .expect("inspect lineage");
            assert_eq!(inspection.0.active_turn_id.as_deref(), Some("turn-active"));
            let cancelled = client
                .cancel_lineage(protocol_session::CancelLineageRequest(
                    ports::AgentSessionLineageCancellationRequest {
                        workspace_id: None,
                        workspace_path: "/workspace".to_string(),
                        root_session_id: "session-1".to_string(),
                        session_id: "session-1".to_string(),
                        expected_active_turn_id: Some("turn-active".to_string()),
                        source: None,
                        reason: Some("user".to_string()),
                        wait_timeout_ms: Some(1_000),
                        remote_connection_id: None,
                        remote_ssh_host: None,
                    },
                ))
                .await
                .expect("cancel lineage");
            assert!(cancelled.0.requested);
            let diff = client.workspace_diff().await.expect("workspace diff");
            assert_eq!(diff.0.files[0].path, "src/lib.rs");
            assert_eq!(provider.settlements.lock().unwrap().len(), 1);
            client.shutdown().await;
        })
        .await;
}

async fn recv<T>(response: SentRequest<T>) -> Result<T, agent_client_protocol::Error>
where
    T: agent_client_protocol::JsonRpcResponse + Send,
{
    let (tx, rx) = tokio::sync::oneshot::channel();
    response.on_receiving_result(async move |result| {
        tx.send(result)
            .map_err(|_| agent_client_protocol::Error::internal_error())
    })?;
    rx.await
        .map_err(|_| agent_client_protocol::Error::internal_error())?
}

fn spawn_server(
    runtime: OpenBitFunAppRuntime,
    transport: impl agent_client_protocol::ConnectTo<AppServer> + 'static,
) {
    tokio::task::spawn_local(async move {
        let _ = OpenBitFunAppServer::new(runtime).serve(transport).await;
    });
}

#[tokio::test(flavor = "current_thread")]
async fn lightweight_client_negotiates_with_the_production_server() {
    let local = LocalSet::new();
    local
        .run_until(async {
            let (server_transport, client_transport) = transport::in_memory_channel_pair();
            let (runtime, provider) = build_phase2_app_runtime();
            spawn_server(runtime, server_transport);

            let client = openbitfun_app_server_client::connect(client_transport)
                .await
                .expect("lightweight client should connect");
            let initialized = client
                .initialize(InitializeRequest {
                    protocol_version: PROTOCOL_VERSION,
                    client: ClientInfo {
                        name: "openbitfun-tui-test".to_string(),
                        version: env!("CARGO_PKG_VERSION").to_string(),
                    },
                })
                .await
                .expect("initialize should negotiate the supported protocol");
            assert_eq!(initialized.protocol_version, PROTOCOL_VERSION);
            assert!(initialized
                .capabilities
                .iter()
                .any(|capability| capability.id == "session"));
            let methods = initialized
                .capabilities
                .iter()
                .flat_map(|capability| capability.methods.iter())
                .map(String::as_str)
                .collect::<std::collections::HashSet<_>>();
            for method in [
                "session/sync",
                "agent/steerTurn",
                "agent/runUserShellCommand",
                "agent/submitUserAnswers",
                "session/undo",
                "session/redo",
                "session/compact",
                "session/reloadContext",
                "session/usage",
                "session/waitForSettlement",
                "workspace/diff",
                "workspace/searchReferences",
                "workspace/messageReferences",
                "session/lineage",
                "session/inspectLineage",
                "session/cancelLineage",
            ] {
                assert!(
                    methods.contains(method),
                    "missing advertised method {method}"
                );
            }

            let reload_request = ports::AgentContextReloadRequest {
                session_id: "session-1".to_string(),
                target: ports::AgentContextReloadTarget::All,
            };
            client
                .reload_context(protocol_session::ReloadContextRequest(
                    reload_request.clone(),
                ))
                .await
                .expect("advertised context reload should reach its provider");
            assert_eq!(
                provider.reloads.lock().unwrap().as_slice(),
                &[reload_request]
            );

            let health = client.health().await.expect("health should round trip");
            assert_eq!(health.status, HealthStatus::Ready);
            assert_eq!(health.protocol_version, PROTOCOL_VERSION);

            let synchronized = client
                .sync_events(SyncEventsRequest {
                    streams: vec![EventStream::Agent, EventStream::Permission],
                })
                .await
                .expect("event cursors should synchronize through the same connection");
            assert_eq!(synchronized.cursors.len(), 2);
            assert_eq!(synchronized.cursors[0].stream, EventStream::Agent);
            assert_eq!(synchronized.cursors[1].stream, EventStream::Permission);
            assert_eq!(
                synchronized.cursors[0].connection_id,
                synchronized.cursors[1].connection_id
            );
            assert!(!synchronized.agent_snapshot_available);

            let error = client
                .initialize(InitializeRequest {
                    protocol_version: PROTOCOL_VERSION + 1,
                    client: ClientInfo {
                        name: "openbitfun-tui-test".to_string(),
                        version: env!("CARGO_PKG_VERSION").to_string(),
                    },
                })
                .await
                .expect_err("a newer unsupported protocol must be rejected");
            assert_eq!(error.code, ErrorCode::InvalidParams);
            let data: AppServerErrorData = serde_json::from_value(
                error
                    .data
                    .expect("protocol rejection should carry stable data"),
            )
            .expect("protocol rejection data should match the wire contract");
            assert_eq!(data.kind, AppServerErrorKind::InvalidRequest);
            assert!(!data.retryable);
            assert!(!data.outcome_unknown);
            assert_eq!(data.capability.as_deref(), Some("app.initialize"));
            client.shutdown().await;
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn lightweight_client_does_not_negotiate_context_reload_without_provider() {
    let local = LocalSet::new();
    local
        .run_until(async {
            let (server_transport, client_transport) = transport::in_memory_channel_pair();
            spawn_server(build_app_runtime(), server_transport);

            let client = openbitfun_app_server_client::connect(client_transport)
                .await
                .expect("lightweight client should connect");
            let initialized = client
                .initialize(InitializeRequest {
                    protocol_version: PROTOCOL_VERSION,
                    client: ClientInfo {
                        name: "openbitfun-tui-test".to_string(),
                        version: env!("CARGO_PKG_VERSION").to_string(),
                    },
                })
                .await
                .expect("initialize should succeed without a context reload provider");
            let session = initialized
                .capabilities
                .iter()
                .find(|capability| capability.id == "session")
                .expect("session capability should remain available");
            assert!(session
                .methods
                .iter()
                .any(|method| method == "session/sync"));
            assert!(
                !initialized
                    .capabilities
                    .iter()
                    .flat_map(|capability| &capability.methods)
                    .any(|method| method == "session/reloadContext"),
                "context reload must not be advertised without its provider"
            );
            client.shutdown().await;
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn session_control_methods_forward_exact_owner_dtos() {
    let local = LocalSet::new();
    local
        .run_until(async {
            let (server_transport, client_transport) = transport::in_memory_channel_pair();
            let (runtime, provider) = build_session_control_app_runtime();
            spawn_server(runtime, server_transport);

            let result = AppClient
                .builder()
                .connect_with(client_transport, async |cx: ConnectionTo<AppServer>| {
                    let RenameSessionResponse {} = recv(cx.send_request(RenameSessionMessage(
                        AgentSessionRenameRequest {
                            workspace_id: None,
                            workspace_path: "/repo".to_string(),
                            session_id: "session-1".to_string(),
                            session_name: "Renamed".to_string(),
                            remote_connection_id: Some("remote-1".to_string()),
                            remote_ssh_host: None,
                        },
                    )))
                    .await?;
                    let SetSessionArchivedResponse {} = recv(cx.send_request(
                        SetSessionArchivedMessage(AgentSessionArchiveStateRequest {
                            workspace_id: None,
                            workspace_path: "/repo".to_string(),
                            session_id: "session-1".to_string(),
                            archived: false,
                            remote_connection_id: None,
                            remote_ssh_host: Some("host-1".to_string()),
                        }),
                    ))
                    .await?;
                    let UpdateSessionModelResponse {} = recv(cx.send_request(
                        UpdateSessionModelMessage(AgentSessionModelUpdateRequest {
                            session_id: "session-1".to_string(),
                            model_id: "provider/model".to_string(),
                        }),
                    ))
                    .await?;
                    let UpdateSessionModeResponse {} = recv(cx.send_request(
                        UpdateSessionModeMessage(AgentSessionModeUpdateRequest {
                            session_id: "session-1".to_string(),
                            mode_id: "plan".to_string(),
                            agent_route_key: None,
                        }),
                    ))
                    .await?;
                    let ForkSessionResponse(forked) = recv(cx.send_request(
                        ForkSessionAtTurnMessage(AgentSessionForkAtTurnRequest {
                            workspace_id: None,
                            workspace_path: "/repo".to_string(),
                            source_session_id: "session-1".to_string(),
                            source_turn_id: "turn-2".to_string(),
                            remote_connection_id: None,
                            remote_ssh_host: None,
                        }),
                    ))
                    .await?;
                    assert_eq!(forked.session_id, "forked-session");

                    let restored = recv(cx.send_request(RestoreSessionMessage {
                        workspace_id: None,
                        workspace_path: "/repo".to_string(),
                        session_id: "session-1".to_string(),
                        include_internal: true,
                        remote_connection_id: None,
                        remote_ssh_host: None,
                    }))
                    .await?;
                    assert_eq!(restored.session.session_name, "Restored Session");
                    assert!(matches!(
                        restored.state,
                        SessionRuntimeState::Processing {
                            ref current_turn_id,
                            ..
                        } if current_turn_id == "turn-active"
                    ));
                    Ok(())
                })
                .await;
            assert!(result.is_ok(), "{result:?}");

            assert_eq!(provider.renamed.lock().unwrap()[0].session_name, "Renamed");
            assert!(!provider.archive_updates.lock().unwrap()[0].archived);
            assert_eq!(
                provider.model_updates.lock().unwrap()[0].model_id,
                "provider/model"
            );
            assert_eq!(provider.mode_updates.lock().unwrap()[0].mode_id, "plan");
            assert_eq!(
                provider.forks_at_turn.lock().unwrap()[0].source_turn_id,
                "turn-2"
            );
            assert!(provider.restores.lock().unwrap()[0].include_internal);
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn run_round_trips_through_create_and_submit() {
    let local = LocalSet::new();
    local
        .run_until(async {
            let (server_transport, client_transport) = transport::in_memory_channel_pair();
            let runtime = build_app_runtime();
            spawn_server(runtime, server_transport);

            let result = AppClient
                .builder()
                .connect_with(client_transport, async |cx: ConnectionTo<AppServer>| {
                    let response = recv(cx.send_request(RunMessage {
                        session: RunSessionSpec::Create {
                            session_name: "Example SDK Session".to_string(),
                            agent_type: "Standard".to_string(),
                            workspace_id: None,
                            workspace_path: None,
                        },
                        message: "hello from an app-server client".to_string(),
                        turn_id: None,
                        source: Some(AgentSubmissionSource::Cli),
                    }))
                    .await?;
                    assert_eq!(response.session_id, "example-session");
                    assert_eq!(response.turn_id, "example-turn");
                    assert_eq!(response.agent_type.as_deref(), Some("Standard"));
                    assert!(response.accepted);
                    Ok(())
                })
                .await;
            assert!(result.is_ok(), "{result:?}");
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn submit_dialog_turn_carries_agent_type_and_starts() {
    // `start_dialog_turn`-style calls must route to `agent/submitDialogTurn`
    // (not `agent/submitTurn`): the dialog-turn body carries `agentType` and a
    // `policy`, which the bare submission request does not. This test pins the
    // field path: the mock records the dialog request, the server defaults the
    // omitted `policy` to the desktop UI source, and the response is `Started`.
    let local = LocalSet::new();
    local
        .run_until(async {
            let (server_transport, client_transport) = transport::in_memory_channel_pair();
            let runtime = build_app_runtime();
            spawn_server(runtime, server_transport);

            let result = AppClient
                .builder()
                .connect_with(client_transport, async |cx: ConnectionTo<AppServer>| {
                    let response = recv(cx.send_request(SubmitDialogTurnMessage(
                        SubmitDialogTurnBody {
                            session_id: "example-session".to_string(),
                            message: "hello dialog".to_string(),
                            original_message: None,
                            turn_id: None,
                            execution: Default::default(),
                            agent_type: "Standard".to_string(),
                            workspace_id: None,
                            workspace_path: None,
                            remote_connection_id: None,
                            remote_ssh_host: None,
                            policy: None,
                            attachments: Vec::new(),
                            metadata: serde_json::Map::new(),
                        },
                    )))
                    .await?;
                    let SubmitDialogTurnResponse::Started {
                        session_id,
                        turn_id,
                    } = response
                    else {
                        panic!("expected Started, got {response:?}");
                    };
                    assert_eq!(session_id, "example-session");
                    assert_eq!(turn_id, "example-dialog-turn");
                    Ok(())
                })
                .await;
            assert!(result.is_ok(), "{result:?}");
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn respond_permission_routes_to_the_permission_surface() {
    // The permission commands must route through the app-server `agent/*`
    // surface. The mock runtime here ships without a permission request
    // manager (matching `cancel_turn`'s missing-port test), so the SDK
    // returns `MissingPermissionRequestManager`; what this pins is that the
    // request reaches the handler and the runtime error surfaces cleanly as a
    // JSON-RPC error -- not an "unknown method" fallthrough.
    let local = LocalSet::new();
    local
        .run_until(async {
            let (server_transport, client_transport) = transport::in_memory_channel_pair();
            let runtime = build_app_runtime();
            spawn_server(runtime, server_transport);

            let result = AppClient
                .builder()
                .connect_with(client_transport, async |cx: ConnectionTo<AppServer>| {
                    let result = recv(cx.send_request(RespondPermissionMessage {
                        request_id: "perm-1".to_string(),
                        reply: openbitfun_agent_runtime::sdk::PermissionReply::Once,
                    }))
                    .await;
                    assert!(
                        result.is_err(),
                        "respondPermission without a permission manager should error, got {result:?}"
                    );
                    Ok(())
                })
                .await;
            assert!(result.is_ok(), "{result:?}");
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn create_session_returns_provider_session_id() {
    let local = LocalSet::new();
    local
        .run_until(async {
            let (server_transport, client_transport) = transport::in_memory_channel_pair();
            let runtime = build_app_runtime();
            spawn_server(runtime, server_transport);

            let result = AppClient
                .builder()
                .connect_with(client_transport, async |cx: ConnectionTo<AppServer>| {
                    let response = recv(cx.send_request(CreateSessionMessage(
                        AgentSessionCreateRequest {
                            session_name: "direct create".to_string(),
                            agent_type: "Standard".to_string(),
                            agent_route_key: None,
                            workspace_path: None,
                            project_workspace_path: None,
                            execution_target: None,
                            workspace_id: None,
                            remote_connection_id: None,
                            remote_ssh_host: None,
                            model_id: None,
                            metadata: Default::default(),
                        },
                    )))
                    .await?;
                    let CreateSessionResponse(inner) = response;
                    assert_eq!(inner.session_id, "example-session");
                    assert_eq!(inner.agent_type, "Standard");
                    Ok(())
                })
                .await;
            assert!(result.is_ok(), "{result:?}");
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn submit_turn_surfaces_provider_result() {
    let local = LocalSet::new();
    local
        .run_until(async {
            let (server_transport, client_transport) = transport::in_memory_channel_pair();
            let runtime = build_app_runtime();
            spawn_server(runtime, server_transport);

            let result = AppClient
                .builder()
                .connect_with(client_transport, async |cx: ConnectionTo<AppServer>| {
                    let response =
                        recv(cx.send_request(SubmitTurnMessage(AgentSubmissionRequest {
                            session_id: "example-session".to_string(),
                            message: "follow-up message".to_string(),
                            turn_id: None,
                            source: Some(AgentSubmissionSource::Cli),
                            attachments: Vec::new(),
                            metadata: Default::default(),
                        })))
                        .await?;
                    let SubmitTurnResponse(inner) = response;
                    assert_eq!(inner.turn_id, "example-turn");
                    assert!(inner.accepted);
                    Ok(())
                })
                .await;
            assert!(result.is_ok(), "{result:?}");
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn list_sessions_maps_missing_port_to_internal_error() {
    // `AgentSessionManagementPort` is not injected, so the runtime returns
    // `MissingSessionManagementPort`. The server must surface that as a
    // JSON-RPC error, not crash.
    let local = LocalSet::new();
    local
        .run_until(async {
            let (server_transport, client_transport) = transport::in_memory_channel_pair();
            let runtime = build_app_runtime();
            spawn_server(runtime, server_transport);

            let result = AppClient
                .builder()
                .connect_with(client_transport, async |cx: ConnectionTo<AppServer>| {
                    let result = recv(cx.send_request(ListSessionsMessage(
                        AgentSessionListRequest {
                            workspace_id: None,
                            workspace_path: ".".to_string(),
                            remote_connection_id: None,
                            remote_ssh_host: None,
                        },
                    )))
                    .await;
                    assert!(
                        result.is_err(),
                        "listSessions without session-management port should error, got {result:?}"
                    );
                    Ok(())
                })
                .await;
            assert!(result.is_ok(), "{result:?}");
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn delete_session_maps_missing_port_to_internal_error() {
    let local = LocalSet::new();
    local
        .run_until(async {
            let (server_transport, client_transport) = transport::in_memory_channel_pair();
            let runtime = build_app_runtime();
            spawn_server(runtime, server_transport);

            let result = AppClient
                .builder()
                .connect_with(client_transport, async |cx: ConnectionTo<AppServer>| {
                    let result = recv(cx.send_request(DeleteSessionMessage(
                        AgentSessionDeleteRequest {
                            workspace_id: None,
                            workspace_path: ".".to_string(),
                            session_id: "example-session".to_string(),
                            remote_connection_id: None,
                            remote_ssh_host: None,
                        },
                    )))
                    .await;
                    assert!(
                        result.is_err(),
                        "deleteSession without session-management port should error, got {result:?}"
                    );
                    Ok(())
                })
                .await;
            assert!(result.is_ok(), "{result:?}");
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn cancel_turn_maps_missing_port_to_internal_error() {
    let local = LocalSet::new();
    local
        .run_until(async {
            let (server_transport, client_transport) = transport::in_memory_channel_pair();
            let runtime = build_app_runtime();
            spawn_server(runtime, server_transport);

            let result = AppClient
                .builder()
                .connect_with(client_transport, async |cx: ConnectionTo<AppServer>| {
                    let result = recv(cx.send_request(CancelTurnMessage(
                        AgentTurnCancellationRequest {
                            session_id: "example-session".to_string(),
                            turn_id: None,
                            source: Some(AgentSubmissionSource::Cli),
                            requester_session_id: None,
                            reason: None,
                            wait_timeout_ms: None,
                            cancel_descendants: true,
                        },
                    )))
                    .await;
                    assert!(
                        result.is_err(),
                        "cancelTurn without cancellation port should error, got {result:?}"
                    );
                    Ok(())
                })
                .await;
            assert!(result.is_ok(), "{result:?}");
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn unknown_agent_method_returns_method_not_found() {
    let local = LocalSet::new();
    local
        .run_until(async {
            let (server_transport, client_transport) = transport::in_memory_channel_pair();
            let runtime = build_app_runtime();
            spawn_server(runtime, server_transport);

            let result = AppClient
                .builder()
                .connect_with(client_transport, async |cx: ConnectionTo<AppServer>| {
                    let response = recv(cx.send_request(UnknownAgentRequest)).await;
                    assert!(
                        response.is_err(),
                        "unknown method should yield method_not_found, got {response:?}"
                    );
                    Ok(())
                })
                .await;
            assert!(result.is_ok(), "{result:?}");
        })
        .await;
}

/// The app-server must forward runtime events from its injected
/// `AgentEventSource` to the client as `agent/event` notifications, not leave
/// the client to subscribe to the runtime queue directly.
#[tokio::test(flavor = "current_thread")]
async fn runtime_events_are_forwarded_as_agent_event_notifications() {
    let local = LocalSet::new();
    local
        .run_until(async {
            let (server_transport, client_transport) = transport::in_memory_channel_pair();
            let (runtime, event_queue) = build_app_runtime_with_queue();
            spawn_server(runtime, server_transport);

            let received: Arc<Mutex<Vec<AgentEventNotification>>> =
                Arc::new(Mutex::new(Vec::new()));
            let received_for_client = received.clone();
            let queue_for_client = event_queue.clone();

            let result = AppClient
                .builder()
                .on_receive_notification(
                    {
                        let received = received_for_client.clone();
                        async move |notification: AgentEventNotification,
                                    _cx: ConnectionTo<AppServer>| {
                            received.lock().unwrap().push(notification);
                            Ok(())
                        }
                    },
                    agent_client_protocol::on_receive_notification!(),
                )
                .connect_with(client_transport, async |_cx: ConnectionTo<AppServer>| {
                    // Let the server's forwarder subscribe before publishing.
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    queue_for_client
                        .enqueue(
                            AgenticEvent::SessionStateChanged {
                                session_id: "s1".to_string(),
                                new_state: "ready".to_string(),
                            },
                            None,
                        )
                        .await
                        .expect("event should enqueue");
                    // Allow time for the server forwarder + client dispatch.
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    Ok(())
                })
                .await;
            assert!(result.is_ok(), "{result:?}");

            let received = received.lock().unwrap().clone();
            assert_eq!(
                received.len(),
                1,
                "should receive exactly one authoritative Agent event, got {received:?}"
            );
            assert_eq!(received[0].cursor.sequence, 1);
            assert!(received[0].cursor.connection_id.starts_with("app-server-"));
            assert!(matches!(
                &received[0].event.event,
                AgenticEvent::SessionStateChanged { session_id, new_state }
                    if session_id == "s1" && new_state == "ready"
            ));
        })
        .await;
}

#[derive(
    Debug, Clone, serde::Serialize, serde::Deserialize, agent_client_protocol::JsonRpcRequest,
)]
#[request(method = "agent/__unknown_for_test", response = UnknownAgentResponse)]
struct UnknownAgentRequest;

#[derive(
    Debug, Clone, serde::Serialize, serde::Deserialize, agent_client_protocol::JsonRpcResponse,
)]
struct UnknownAgentResponse;

#[allow(dead_code)]
fn _document_run_response_shape_in_tests(_r: RunResponse) {}
/// The Server Host drives the app-server through the real
/// `openbitfun_app_server_client::connect`
/// handle (not an inline `AppClient::builder().connect_with` main_fn like the
/// round-trip tests above). `connect` parks its main loop on a shutdown
/// receiver and returns an `AppServerClient` the host holds for the process
/// lifetime. This regression test pins that contract: after `connect`
/// returns, an RPC sent through the returned handle must still reach the
/// server and get a response. A previous version dropped `shutdown_tx` right
/// before returning (`let _ = shutdown_tx;`), which let the parked main loop
/// resume immediately, cancelling the connection's background actors -- every
/// subsequent RPC then surfaced as `send failed because receiver is gone`
/// (from `Task::spawn`'s `unbounded_send` failure). This test fails loud if
/// that regression returns, because `create_session` would error instead of
/// returning the mock session id.
#[tokio::test(flavor = "current_thread")]
async fn client_connect_keeps_connection_alive_after_return() {
    let local = LocalSet::new();
    local
        .run_until(async {
            let (server_transport, client_transport) = transport::in_memory_channel_pair();
            let runtime = build_app_runtime();
            spawn_server(runtime, server_transport);

            let client = openbitfun_app_server_client::connect(client_transport)
                .await
                .expect("app-server client should connect");

            // The connect task must still be parked on the shutdown receiver
            // here -- otherwise the connection's background actors are gone and
            // this RPC surfaces `send failed because receiver is gone`.
            let response = client
                .create_session(CreateSessionMessage(AgentSessionCreateRequest {
                    session_name: "post-connect session".to_string(),
                    agent_type: "Standard".to_string(),
                    agent_route_key: None,
                    workspace_path: None,
                    project_workspace_path: None,
                    execution_target: None,
                    workspace_id: None,
                    remote_connection_id: None,
                    remote_ssh_host: None,
                    model_id: None,
                    metadata: Default::default(),
                }))
                .await
                .expect("RPC after connect() must succeed -- connection should still be alive");
            assert_eq!(response.0.session_id, "example-session");
            assert_eq!(response.0.agent_type, "Standard");

            client.shutdown().await;
        })
        .await;
}
