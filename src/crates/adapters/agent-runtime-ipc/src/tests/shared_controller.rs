use crate::{
    read_frame, write_frame, InitializeRequest, LocalIpcStream, RuntimeInstanceIdentity,
    RuntimeIpcClient, RuntimeIpcClientError, RuntimeIpcError, RuntimeIpcErrorCode, RuntimeIpcEvent,
    RuntimeIpcFrame, RuntimeIpcOperation, RuntimeIpcOperationResult, RuntimeIpcRequestHandler,
    RuntimeIpcServer, RuntimeIpcServerConfig, RuntimeSessionForkRequest,
    RuntimeSessionRenameRequest, RuntimeSessionRestoreRequest, PROTOCOL_VERSION,
};
use async_trait::async_trait;
use openbitfun_events::{AgenticEvent, AgenticEventEnvelope, AgenticEventPriority};
use openbitfun_runtime_ports::{
    AgentDialogTurnRequest, AgentSessionCompactionRequest, AgentSessionComposerUpdate,
    AgentSessionCreateRequest, AgentSessionCreateResult, AgentSessionLineageCancellationRequest,
    AgentSessionLineageTranscriptRequest, AgentSessionModeUpdateRequest,
    AgentSessionModelUpdateRequest, AgentSessionRevertRequest, AgentSessionRevertResult,
    AgentSessionSummary, AgentSessionWorkspaceBinding, AgentSubmissionSource,
    AgentUserShellCommandRequest, DialogSubmissionPolicy, SessionExecutionTarget,
    SessionTranscript,
};
use serde_json::Map;
use std::path::Path;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tempfile::{tempdir, TempDir};
use tokio::io::AsyncWriteExt;
use tokio::sync::{broadcast, watch, Notify};
type EventSubscription = Result<broadcast::Receiver<RuntimeIpcEvent>, RuntimeIpcError>;

fn test_agent_event(session_id: &str, turn_id: &str) -> RuntimeIpcEvent {
    RuntimeIpcEvent::Agent {
        session_id: session_id.to_string(),
        envelope: AgenticEventEnvelope::new(
            AgenticEvent::DialogTurnCancelled {
                session_id: session_id.to_string(),
                turn_id: turn_id.to_string(),
            },
            AgenticEventPriority::Critical,
        ),
    }
}

struct TestServer {
    runtime_root: TempDir,
    workspace: TempDir,
    endpoint: crate::LocalIpcEndpoint,
    discovery: crate::DiscoveryRecord,
    task: tokio::task::JoinHandle<Result<(), crate::RuntimeIpcServerError>>,
}

impl TestServer {
    async fn start<H: RuntimeIpcRequestHandler + 'static>(
        config: RuntimeIpcServerConfig,
        handler: Arc<H>,
    ) -> Self {
        let runtime_root = tempdir().expect("runtime root");
        let workspace = tempdir().expect("workspace");
        let server = RuntimeIpcServer::bind_with_handler(
            runtime_root.path(),
            test_identity(workspace.path()),
            config,
            handler,
        )
        .await
        .expect("bind shared server");
        let endpoint = server.endpoint().clone();
        let discovery = server.discovery_record().clone();
        Self {
            runtime_root,
            workspace,
            endpoint,
            discovery,
            task: tokio::spawn(server.serve()),
        }
    }

    async fn connect(&self, client_id: &str) -> LocalIpcStream {
        initialize(&self.endpoint, &self.discovery, client_id).await
    }

    async fn finish(self) {
        self.task.await.unwrap().unwrap();
    }
}

struct FakeHandler {
    calls: Mutex<Vec<RuntimeIpcOperation>>,
    delay: Option<Duration>,
    mode_delay: Option<Duration>,
    model_delay: Option<Duration>,
    rename_delay: Option<Duration>,
    delete_delay: Option<Duration>,
    submit_delay: Option<Duration>,
    lineage_read_delay: Option<Duration>,
    invalid_steer_result: bool,
    settle_cancel: bool,
    events: broadcast::Sender<RuntimeIpcEvent>,
    available: watch::Sender<bool>,
}

struct CreateRaceHandler {
    create_started: Arc<Notify>,
    allow_create: Arc<Notify>,
    available: Arc<AtomicBool>,
    events: broadcast::Sender<RuntimeIpcEvent>,
}

impl Default for FakeHandler {
    fn default() -> Self {
        let (events, _) = broadcast::channel(16);
        let (available, _) = watch::channel(true);
        Self {
            calls: Mutex::new(Vec::new()),
            delay: None,
            mode_delay: None,
            model_delay: None,
            rename_delay: None,
            delete_delay: None,
            submit_delay: None,
            lineage_read_delay: None,
            invalid_steer_result: false,
            settle_cancel: true,
            events,
            available,
        }
    }
}

#[async_trait]
impl RuntimeIpcRequestHandler for CreateRaceHandler {
    fn ensure_available(&self) -> Result<(), RuntimeIpcError> {
        self.available
            .load(Ordering::SeqCst)
            .then_some(())
            .ok_or(RuntimeIpcError {
                code: RuntimeIpcErrorCode::Unavailable,
                message: "fixture event stream unavailable".to_string(),
            })
    }

    async fn execute(
        &self,
        operation: RuntimeIpcOperation,
    ) -> Result<RuntimeIpcOperationResult, RuntimeIpcError> {
        match operation {
            RuntimeIpcOperation::CreateSession { request } => {
                self.create_started.notify_one();
                self.allow_create.notified().await;
                let mut session =
                    AgentSessionCreateResult::new("session-a", "Created session", "Standard");
                session.workspace_path = request.workspace_path;
                session.workspace_id = Some("workspace-fixture".to_string());
                Ok(RuntimeIpcOperationResult::SessionCreated { session })
            }
            RuntimeIpcOperation::RestoreSession { request } => Ok(restored(&request.session_id)),
            _ => Ok(RuntimeIpcOperationResult::Unit),
        }
    }

    fn subscribe_events(&self, _session_id: &str) -> EventSubscription {
        self.ensure_available().map(|()| self.events.subscribe())
    }
}

#[async_trait]
impl RuntimeIpcRequestHandler for FakeHandler {
    fn ensure_available(&self) -> Result<(), RuntimeIpcError> {
        (*self.available.borrow())
            .then_some(())
            .ok_or(RuntimeIpcError {
                code: RuntimeIpcErrorCode::Unavailable,
                message: "fixture event stream unavailable".to_string(),
            })
    }

    fn subscribe_availability(&self) -> Option<watch::Receiver<bool>> {
        Some(self.available.subscribe())
    }

    async fn execute(
        &self,
        operation: RuntimeIpcOperation,
    ) -> Result<RuntimeIpcOperationResult, RuntimeIpcError> {
        self.calls
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(operation.clone());
        if let Some(delay) = self.delay {
            tokio::time::sleep(delay).await;
        }
        if matches!(operation, RuntimeIpcOperation::UpdateSessionMode { .. }) {
            if let Some(delay) = self.mode_delay {
                tokio::time::sleep(delay).await;
            }
        }
        if matches!(operation, RuntimeIpcOperation::UpdateSessionModel { .. }) {
            if let Some(delay) = self.model_delay {
                tokio::time::sleep(delay).await;
            }
        }
        if matches!(operation, RuntimeIpcOperation::RenameSession { .. }) {
            if let Some(delay) = self.rename_delay {
                tokio::time::sleep(delay).await;
            }
        }
        if matches!(operation, RuntimeIpcOperation::DeleteSession { .. }) {
            if let Some(delay) = self.delete_delay {
                tokio::time::sleep(delay).await;
            }
        }
        if matches!(
            operation,
            RuntimeIpcOperation::GetSessionLineage { .. }
                | RuntimeIpcOperation::InspectLineageSession { .. }
        ) {
            if let Some(delay) = self.lineage_read_delay {
                tokio::time::sleep(delay).await;
            }
        }
        match operation {
            RuntimeIpcOperation::RestoreSession { request } => Ok(restored(&request.session_id)),
            RuntimeIpcOperation::ForkSession { .. } => {
                Ok(RuntimeIpcOperationResult::SessionForked {
                    session: summary("session-fork"),
                    transcript: SessionTranscript {
                        session_id: "session-fork".to_string(),
                        messages: Vec::new(),
                    },
                    workspace_binding: workspace_binding(),
                })
            }
            RuntimeIpcOperation::SubmitTurn { request } => {
                if let Some(delay) = self.submit_delay {
                    tokio::time::sleep(delay).await;
                }
                Ok(RuntimeIpcOperationResult::TurnAccepted {
                    session_id: request.session_id,
                    turn_id: request.turn_id.expect("test turn id"),
                })
            }
            RuntimeIpcOperation::SteerTurn { request } => {
                if self.invalid_steer_result {
                    return Ok(RuntimeIpcOperationResult::Unit);
                }
                Ok(RuntimeIpcOperationResult::TurnSteered {
                    session_id: request.session_id,
                    turn_id: request.turn_id,
                    steering_id: "steer-fixture".to_string(),
                })
            }
            RuntimeIpcOperation::RunUserShellCommand { request } => {
                if let Some(delay) = self.submit_delay {
                    tokio::time::sleep(delay).await;
                }
                Ok(RuntimeIpcOperationResult::TurnAccepted {
                    session_id: request.session_id,
                    turn_id: request.turn_id,
                })
            }
            RuntimeIpcOperation::CompactSession { request } => {
                Ok(RuntimeIpcOperationResult::TurnAccepted {
                    session_id: request.session_id,
                    turn_id: request.turn_id,
                })
            }
            RuntimeIpcOperation::InspectLineageSession { request } => {
                Ok(RuntimeIpcOperationResult::LineageSessionInspection {
                    inspection: openbitfun_runtime_ports::AgentSessionLineageInspection {
                        transcript: SessionTranscript {
                            session_id: request.session_id,
                            messages: Vec::new(),
                        },
                        active_turn_id: None,
                    },
                })
            }
            RuntimeIpcOperation::CancelLineageSession { request } => {
                Ok(RuntimeIpcOperationResult::TurnCancelled {
                    cancellation: openbitfun_runtime_ports::AgentTurnCancellationResult {
                        session_id: request.session_id,
                        turn_id: None,
                        requested: true,
                    },
                })
            }
            RuntimeIpcOperation::UndoSession { request }
            | RuntimeIpcOperation::RedoSession { request } => {
                Ok(RuntimeIpcOperationResult::SessionReverted {
                    revert: AgentSessionRevertResult {
                        transcript: SessionTranscript {
                            session_id: request.session_id.clone(),
                            messages: Vec::new(),
                        },
                        session_id: request.session_id,
                        composer: AgentSessionComposerUpdate::Preserve,
                        retired_turn_ids: Vec::new(),
                        changed: true,
                        hidden_turn_count: 1,
                        boundary_storage_turn_index: None,
                        target_turn_id: None,
                        restored_files: Vec::new(),
                        reload_required: false,
                        reload_reason: None,
                    },
                })
            }
            RuntimeIpcOperation::CancelTurn { request } => {
                if self.settle_cancel {
                    let _ = self.events.send(test_agent_event(
                        &request.session_id,
                        request.turn_id.as_deref().expect("cancel turn id"),
                    ));
                }
                Ok(RuntimeIpcOperationResult::TurnCancelled {
                    cancellation: openbitfun_runtime_ports::AgentTurnCancellationResult {
                        session_id: request.session_id,
                        turn_id: request.turn_id,
                        requested: true,
                    },
                })
            }
            _ => Ok(RuntimeIpcOperationResult::Unit),
        }
    }

    fn subscribe_events(&self, _session_id: &str) -> EventSubscription {
        Ok(self.events.subscribe())
    }
}

#[tokio::test]
async fn authenticated_partial_frame_is_closed_at_the_request_deadline() {
    let mut config = server_config();
    config.request_timeout = Duration::from_millis(20);
    let handler = Arc::new(FakeHandler::default());
    let server = TestServer::start(config, handler.clone()).await;
    let mut client = server.connect("partial-frame").await;
    expect_response(
        &mut client,
        2,
        restore_operation(server.workspace.path(), "session-a"),
    )
    .await;
    client.write_u32(10).await.unwrap();
    client.write_all(b"{").await.unwrap();
    let events = handler.events.clone();
    let emitter = tokio::spawn(async move {
        loop {
            let _ = events.send(test_agent_event("session-a", "turn-a"));
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    });
    assert!(tokio::time::timeout(Duration::from_millis(200), async {
        while read_frame(&mut client).await.is_ok() {}
    })
    .await
    .is_ok());
    emitter.abort();
    drop(client);
    server.finish().await;
}

#[tokio::test]
async fn startup_connection_closes_when_runtime_becomes_unavailable() {
    let handler = Arc::new(FakeHandler::default());
    let server = TestServer::start(server_config(), handler.clone()).await;
    let mut client = server.connect("startup-page").await;
    handler.available.send_replace(false);
    assert!(
        tokio::time::timeout(Duration::from_millis(200), read_frame(&mut client))
            .await
            .expect("startup connection closes")
            .is_err()
    );
    drop(client);
    server.finish().await;
}

#[tokio::test]
async fn oversized_event_reports_typed_invalidation_before_disconnect() {
    let handler = Arc::new(FakeHandler::default());
    let server = TestServer::start(server_config(), handler.clone()).await;
    let mut client = server.connect("oversized-event").await;
    expect_response(
        &mut client,
        2,
        restore_operation(server.workspace.path(), "session-a"),
    )
    .await;
    handler
        .events
        .send(RuntimeIpcEvent::Agent {
            session_id: "session-a".to_string(),
            envelope: AgenticEventEnvelope::new(
                AgenticEvent::TextChunk {
                    session_id: "session-a".to_string(),
                    turn_id: "turn-a".to_string(),
                    round_id: "round-a".to_string(),
                    attempt_id: None,
                    attempt_index: None,
                    text: "x".repeat(9 * 1024 * 1024),
                },
                AgenticEventPriority::Critical,
            ),
        })
        .unwrap();
    assert!(matches!(
        read_frame(&mut client).await.unwrap(),
        RuntimeIpcFrame::Event {
            event: RuntimeIpcEvent::StreamInvalidated {
                reason: crate::RuntimeIpcStreamInvalidationReason::FrameTooLarge,
            }
        }
    ));
    drop(client);
    server.finish().await;
}

#[tokio::test]
async fn first_party_timeout_reports_unknown_outcome_and_releases_the_lease() {
    let mut config = server_config();
    config.request_timeout = Duration::from_millis(100);
    let handler = Arc::new(FakeHandler {
        delay: Some(Duration::from_millis(250)),
        ..FakeHandler::default()
    });
    let server = TestServer::start(config, handler.clone()).await;
    for client_id in ["first-timeout", "second-timeout"] {
        let client = RuntimeIpcClient::connect(
            server.runtime_root.path(),
            &server.discovery,
            client_id,
            "0.1.0",
            Duration::from_secs(2),
            Duration::from_secs(2),
        )
        .await
        .expect("connect first-party client");
        let restore = client
            .request(restore_operation(server.workspace.path(), "session-a"))
            .await;
        assert!(
            matches!(
                restore,
                Err(RuntimeIpcClientError::Remote(RuntimeIpcError {
                    code: RuntimeIpcErrorCode::OutcomeUnknown,
                    ..
                }))
            ),
            "unexpected restore result: {restore:?}"
        );
    }
    server.finish().await;
}

#[tokio::test]
async fn cancellation_supersedes_a_slow_lineage_read_on_the_same_client() {
    let handler = Arc::new(FakeHandler {
        lineage_read_delay: Some(Duration::from_secs(2)),
        ..FakeHandler::default()
    });
    let server = TestServer::start(server_config(), handler.clone()).await;
    let client = RuntimeIpcClient::connect(
        server.runtime_root.path(),
        &server.discovery,
        "lineage-controller",
        "0.1.0",
        Duration::from_secs(2),
        Duration::from_secs(3),
    )
    .await
    .expect("connect first-party client");
    client
        .request(restore_operation(server.workspace.path(), "session-a"))
        .await
        .expect("restore root session");

    let inspect_client = client.clone();
    let workspace_path = server.workspace.path().to_string_lossy().to_string();
    let inspect_workspace_path = workspace_path.clone();
    let inspect = tokio::spawn(async move {
        inspect_client
            .request(RuntimeIpcOperation::InspectLineageSession {
                request: AgentSessionLineageTranscriptRequest {
                    workspace_id: None,
                    workspace_path: inspect_workspace_path,
                    root_session_id: "session-a".to_string(),
                    session_id: "session-child".to_string(),
                    required_settled_turn_ids: Vec::new(),
                    remote_connection_id: None,
                    remote_ssh_host: None,
                },
            })
            .await
    });
    wait_for_calls(&handler, |calls| {
        calls
            .iter()
            .any(|call| matches!(call, RuntimeIpcOperation::InspectLineageSession { .. }))
    })
    .await;

    let cancellation = tokio::time::timeout(
        Duration::from_millis(300),
        client.request(RuntimeIpcOperation::CancelLineageSession {
            request: AgentSessionLineageCancellationRequest {
                workspace_id: None,
                workspace_path,
                root_session_id: "session-a".to_string(),
                session_id: "session-child".to_string(),
                expected_active_turn_id: Some("turn-child".to_string()),
                source: None,
                reason: None,
                wait_timeout_ms: None,
                remote_connection_id: None,
                remote_ssh_host: None,
            },
        }),
    )
    .await
    .expect("lineage cancellation must not wait for transcript I/O")
    .expect("cancel response");
    assert!(matches!(
        cancellation,
        RuntimeIpcOperationResult::TurnCancelled { cancellation }
            if cancellation.requested && cancellation.session_id == "session-child"
    ));
    assert!(matches!(
        inspect.await.expect("inspect task"),
        Err(RuntimeIpcClientError::Remote(RuntimeIpcError {
            code: RuntimeIpcErrorCode::Unavailable,
            ..
        }))
    ));

    drop(client);
    server.finish().await;
}

#[tokio::test]
async fn generated_session_is_claimed_before_another_connection_can_restore_it() {
    let create_started = Arc::new(Notify::new());
    let allow_create = Arc::new(Notify::new());
    let server = TestServer::start(
        server_config(),
        Arc::new(CreateRaceHandler {
            create_started: create_started.clone(),
            allow_create: allow_create.clone(),
            available: Arc::new(AtomicBool::new(true)),
            events: broadcast::channel(16).0,
        }),
    )
    .await;
    let mut creator = server.connect("creator").await;
    let mut restorer = server.connect("restorer").await;
    let workspace_path = server.workspace.path().to_string_lossy().to_string();
    let expected_workspace_path = workspace_path.clone();

    let create_task = tokio::spawn(async move {
        request(
            &mut creator,
            2,
            create_operation(Path::new(&workspace_path), "Created session"),
        )
        .await
    });
    create_started.notified().await;
    let restore_task = tokio::spawn(async move {
        request(
            &mut restorer,
            2,
            RuntimeIpcOperation::RestoreSession {
                request: RuntimeSessionRestoreRequest {
                    workspace_id: None,
                    workspace_path: "fixture-workspace".to_string(),
                    session_id: "session-a".to_string(),
                },
            },
        )
        .await
    });

    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(
        !restore_task.is_finished(),
        "restore must wait until create has claimed its generated Session"
    );
    allow_create.notify_one();
    match create_task.await.expect("create task") {
        RuntimeIpcFrame::Response {
            result: RuntimeIpcOperationResult::SessionCreated { session },
            ..
        } => {
            assert_eq!(
                session.workspace_path.as_deref(),
                Some(expected_workspace_path.as_str())
            );
            assert_eq!(session.workspace_id.as_deref(), Some("workspace-fixture"));
        }
        other => panic!("unexpected create response: {other:?}"),
    }
    assert!(matches!(
        restore_task.await.expect("restore task"),
        RuntimeIpcFrame::Error { error, .. }
            if error.code == RuntimeIpcErrorCode::SessionInUse
    ));

    server.finish().await;
}

fn summary(session_id: &str) -> AgentSessionSummary {
    AgentSessionSummary {
        session_id: session_id.to_string(),
        session_name: "Shared session".to_string(),
        agent_type: "Standard".to_string(),
        model_id: None,
        reasoning_preset: None,
        last_user_dialog_agent_type: None,
        last_submitted_agent_type: None,
        turn_count: 0,
        created_at_ms: 1,
        last_active_at_ms: 1,
    }
}

fn restored(session_id: &str) -> RuntimeIpcOperationResult {
    RuntimeIpcOperationResult::SessionRestored {
        session: summary(session_id),
        state: crate::RuntimeSessionState::Idle,
        transcript: SessionTranscript {
            session_id: session_id.to_string(),
            messages: Vec::new(),
        },
        pending_permissions: Vec::new(),
        workspace_binding: workspace_binding(),
    }
}

fn workspace_binding() -> AgentSessionWorkspaceBinding {
    AgentSessionWorkspaceBinding {
        workspace_kind: None,
        project_workspace_id: None,
        workspace_id: Some("workspace-fixture".to_string()),
        workspace_path: "/workspace".to_string(),
        project_workspace_path: Some("/workspace".to_string()),
        execution_target: Some(SessionExecutionTarget::local("/workspace")),
        remote_connection_id: None,
        remote_ssh_host: None,
    }
}

fn test_identity(workspace: &Path) -> RuntimeInstanceIdentity {
    RuntimeInstanceIdentity::for_workspace(
        workspace,
        "openbitfun",
        "stable",
        "user-a",
        PROTOCOL_VERSION,
    )
    .expect("runtime identity")
}

fn restore_operation(workspace: &Path, session_id: &str) -> RuntimeIpcOperation {
    RuntimeIpcOperation::RestoreSession {
        request: RuntimeSessionRestoreRequest {
            workspace_id: None,
            workspace_path: workspace.to_string_lossy().to_string(),
            session_id: session_id.to_string(),
        },
    }
}

fn create_operation(workspace: &Path, name: &str) -> RuntimeIpcOperation {
    RuntimeIpcOperation::CreateSession {
        request: AgentSessionCreateRequest {
            session_name: name.to_string(),
            agent_type: "Standard".to_string(),
            agent_route_key: None,
            workspace_path: Some(workspace.to_string_lossy().to_string()),
            project_workspace_path: None,
            execution_target: None,
            workspace_id: None,
            remote_connection_id: None,
            remote_ssh_host: None,
            model_id: None,
            metadata: Map::new(),
        },
    }
}

fn submit_operation(workspace: &Path, session_id: &str, turn_id: &str) -> RuntimeIpcOperation {
    RuntimeIpcOperation::SubmitTurn {
        request: AgentDialogTurnRequest {
            session_id: session_id.to_string(),
            message: "hello".to_string(),
            output_schema: None,
            original_message: None,
            turn_id: Some(turn_id.to_string()),
            execution: Default::default(),
            agent_type: "Standard".to_string(),
            workspace_path: Some(workspace.to_string_lossy().to_string()),
            workspace_id: None,
            remote_connection_id: None,
            remote_ssh_host: None,
            policy: DialogSubmissionPolicy::for_source(AgentSubmissionSource::Cli),
            reply_route: None,
            prepended_reminders: Vec::new(),
            attachments: Vec::new(),
            metadata: Map::new(),
        },
    }
}

fn steer_operation(session_id: &str, turn_id: &str) -> RuntimeIpcOperation {
    RuntimeIpcOperation::SteerTurn {
        request: openbitfun_runtime_ports::AgentDialogSteerRequest {
            session_id: session_id.to_string(),
            turn_id: turn_id.to_string(),
            content: "check tests".to_string(),
            display_content: None,
            attachments: Vec::new(),
            metadata: serde_json::Map::new(),
        },
    }
}

fn shell_operation(session_id: &str, turn_id: &str) -> RuntimeIpcOperation {
    RuntimeIpcOperation::RunUserShellCommand {
        request: AgentUserShellCommandRequest {
            session_id: session_id.to_string(),
            turn_id: turn_id.to_string(),
            command: "git status --short".to_string(),
        },
    }
}

fn compact_operation(session_id: &str, turn_id: &str) -> RuntimeIpcOperation {
    RuntimeIpcOperation::CompactSession {
        request: AgentSessionCompactionRequest {
            session_id: session_id.to_string(),
            turn_id: turn_id.to_string(),
        },
    }
}

fn undo_operation(workspace: &Path, session_id: &str) -> RuntimeIpcOperation {
    RuntimeIpcOperation::UndoSession {
        request: AgentSessionRevertRequest {
            workspace_id: None,
            workspace_path: workspace.to_string_lossy().to_string(),
            session_id: session_id.to_string(),
            remote_connection_id: None,
            remote_ssh_host: None,
        },
    }
}

fn update_mode_operation(session_id: &str, mode_id: &str) -> RuntimeIpcOperation {
    RuntimeIpcOperation::UpdateSessionMode {
        request: AgentSessionModeUpdateRequest {
            session_id: session_id.to_string(),
            mode_id: mode_id.to_string(),
            agent_route_key: None,
        },
    }
}

fn update_model_operation(session_id: &str, model_id: &str) -> RuntimeIpcOperation {
    RuntimeIpcOperation::UpdateSessionModel {
        request: AgentSessionModelUpdateRequest {
            session_id: session_id.to_string(),
            model_id: model_id.to_string(),
        },
    }
}

fn rename_operation(session_id: &str, session_name: &str) -> RuntimeIpcOperation {
    RuntimeIpcOperation::RenameSession {
        request: RuntimeSessionRenameRequest {
            session_id: session_id.to_string(),
            session_name: session_name.to_string(),
        },
    }
}

fn fork_operation(session_id: &str, before_turn_id: Option<&str>) -> RuntimeIpcOperation {
    RuntimeIpcOperation::ForkSession {
        request: RuntimeSessionForkRequest {
            session_id: session_id.to_string(),
            before_turn_id: before_turn_id.map(str::to_string),
        },
    }
}

fn delete_operation(session_id: &str) -> RuntimeIpcOperation {
    RuntimeIpcOperation::DeleteSession {
        session_id: session_id.to_string(),
    }
}

fn server_config() -> RuntimeIpcServerConfig {
    RuntimeIpcServerConfig {
        server_version: "shared-controller-test".to_string(),
        idle_timeout: Duration::from_millis(100),
        handshake_timeout: Duration::from_secs(2),
        request_timeout: Duration::from_secs(2),
        max_connections: 4,
    }
}

async fn initialize(
    endpoint: &crate::LocalIpcEndpoint,
    discovery: &crate::DiscoveryRecord,
    client_id: &str,
) -> LocalIpcStream {
    let mut stream = endpoint
        .connect(Duration::from_secs(2))
        .await
        .expect("connect local stream");
    write_frame(
        &mut stream,
        &RuntimeIpcFrame::Initialize {
            request_id: 1,
            request: InitializeRequest {
                protocol_version: PROTOCOL_VERSION,
                instance_identity: discovery.instance_identity.as_str().to_string(),
                token: discovery.token.clone(),
                client_id: client_id.to_string(),
                client_version: "0.1.0".to_string(),
            },
        },
    )
    .await
    .expect("initialize request");
    assert!(matches!(
        read_frame(&mut stream).await.expect("initialize response"),
        RuntimeIpcFrame::Initialized { result, .. } if result.capabilities.interactive_tui
    ));
    stream
}

async fn request(
    stream: &mut LocalIpcStream,
    request_id: u64,
    operation: RuntimeIpcOperation,
) -> RuntimeIpcFrame {
    write_frame(
        stream,
        &RuntimeIpcFrame::Request {
            request_id,
            operation,
        },
    )
    .await
    .expect("write operation");
    read_frame(stream).await.expect("read operation response")
}

async fn expect_response(
    stream: &mut LocalIpcStream,
    request_id: u64,
    operation: RuntimeIpcOperation,
) {
    assert!(matches!(
        request(stream, request_id, operation).await,
        RuntimeIpcFrame::Response { .. }
    ));
}

async fn expect_error(
    stream: &mut LocalIpcStream,
    request_id: u64,
    operation: RuntimeIpcOperation,
    expected: RuntimeIpcErrorCode,
) {
    assert!(matches!(
        request(stream, request_id, operation).await,
        RuntimeIpcFrame::Error { error, .. } if error.code == expected
    ));
}

async fn wait_for_calls(handler: &FakeHandler, ready: impl Fn(&[RuntimeIpcOperation]) -> bool) {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let found = {
                let calls = handler.calls.lock().expect("calls");
                ready(&calls)
            };
            if found {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("expected runtime operation");
}

#[tokio::test]
async fn session_switching_is_exclusive_and_disconnect_releases_control() {
    let server = TestServer::start(server_config(), Arc::new(FakeHandler::default())).await;
    let mut first = server.connect("first-controller").await;
    let mut second = server.connect("second-controller").await;
    expect_response(
        &mut first,
        2,
        restore_operation(server.workspace.path(), "session-a"),
    )
    .await;
    expect_error(
        &mut second,
        2,
        restore_operation(server.workspace.path(), "session-a"),
        RuntimeIpcErrorCode::SessionInUse,
    )
    .await;
    expect_response(
        &mut second,
        3,
        restore_operation(server.workspace.path(), "session-b"),
    )
    .await;
    expect_error(
        &mut first,
        3,
        restore_operation(server.workspace.path(), "session-b"),
        RuntimeIpcErrorCode::SessionInUse,
    )
    .await;
    expect_response(
        &mut first,
        4,
        restore_operation(server.workspace.path(), "session-a"),
    )
    .await;

    drop(first);
    tokio::time::sleep(Duration::from_millis(30)).await;
    expect_response(
        &mut second,
        4,
        restore_operation(server.workspace.path(), "session-a"),
    )
    .await;
    drop(second);
    server.finish().await;
}

#[tokio::test]
async fn session_scoped_agent_catalog_requires_the_current_controller() {
    let server = TestServer::start(server_config(), Arc::new(FakeHandler::default())).await;
    let mut client = server.connect("catalog-controller").await;

    expect_response(
        &mut client,
        2,
        RuntimeIpcOperation::ListAgentModes { session_id: None },
    )
    .await;
    expect_error(
        &mut client,
        3,
        RuntimeIpcOperation::ListAgentModes {
            session_id: Some("session-a".to_string()),
        },
        RuntimeIpcErrorCode::ControllerRequired,
    )
    .await;
    expect_response(
        &mut client,
        4,
        restore_operation(server.workspace.path(), "session-a"),
    )
    .await;
    expect_response(
        &mut client,
        5,
        RuntimeIpcOperation::ListAgentModes {
            session_id: Some("session-a".to_string()),
        },
    )
    .await;

    drop(client);
    server.finish().await;
}

#[tokio::test]
async fn successful_fork_atomically_transfers_control_and_releases_the_source() {
    let server = TestServer::start(server_config(), Arc::new(FakeHandler::default())).await;
    let mut forker = server.connect("fork-controller").await;
    let mut observer = server.connect("source-controller").await;

    expect_response(
        &mut forker,
        2,
        restore_operation(server.workspace.path(), "session-a"),
    )
    .await;
    assert!(matches!(
        request(&mut forker, 3, fork_operation("session-a", Some("turn-2"))).await,
        RuntimeIpcFrame::Response {
            result: RuntimeIpcOperationResult::SessionForked { session, .. },
            ..
        } if session.session_id == "session-fork"
    ));

    expect_response(
        &mut observer,
        2,
        restore_operation(server.workspace.path(), "session-a"),
    )
    .await;
    expect_error(
        &mut forker,
        4,
        update_mode_operation("session-a", "ask"),
        RuntimeIpcErrorCode::SessionMismatch,
    )
    .await;
    expect_response(&mut forker, 5, update_mode_operation("session-fork", "ask")).await;
    expect_error(
        &mut observer,
        3,
        restore_operation(server.workspace.path(), "session-fork"),
        RuntimeIpcErrorCode::SessionInUse,
    )
    .await;

    drop(forker);
    drop(observer);
    server.finish().await;
}

#[tokio::test]
async fn one_connection_rejects_a_second_turn_until_the_first_finishes() {
    let handler = Arc::new(FakeHandler::default());
    let server = TestServer::start(server_config(), handler.clone()).await;
    let mut client = server.connect("controller").await;
    expect_response(
        &mut client,
        2,
        restore_operation(server.workspace.path(), "session-a"),
    )
    .await;
    expect_response(
        &mut client,
        3,
        submit_operation(server.workspace.path(), "session-a", "turn-a"),
    )
    .await;
    expect_error(
        &mut client,
        4,
        submit_operation(server.workspace.path(), "session-a", "turn-b"),
        RuntimeIpcErrorCode::SessionInUse,
    )
    .await;
    expect_error(
        &mut client,
        5,
        restore_operation(server.workspace.path(), "session-b"),
        RuntimeIpcErrorCode::SessionInUse,
    )
    .await;
    expect_error(
        &mut client,
        6,
        fork_operation("session-a", None),
        RuntimeIpcErrorCode::SessionInUse,
    )
    .await;

    drop(client);
    wait_for_calls(&handler, |calls| {
        let submitted = calls
            .iter()
            .filter(|call| matches!(call, RuntimeIpcOperation::SubmitTurn { .. }))
            .count();
        let cancelled_first = calls.iter().any(|call| {
            matches!(
                call,
                RuntimeIpcOperation::CancelTurn { request }
                    if request.session_id == "session-a"
                        && request.turn_id.as_deref() == Some("turn-a")
            )
        });
        let forked = calls
            .iter()
            .any(|call| matches!(call, RuntimeIpcOperation::ForkSession { .. }));
        submitted == 1 && !forked && cancelled_first
    })
    .await;
    server.finish().await;
}

#[tokio::test]
async fn steering_requires_and_preserves_the_connections_exact_active_turn() {
    let handler = Arc::new(FakeHandler::default());
    let server = TestServer::start(server_config(), handler.clone()).await;
    let mut client = server.connect("steering-controller").await;
    expect_response(
        &mut client,
        2,
        restore_operation(server.workspace.path(), "session-a"),
    )
    .await;
    expect_response(
        &mut client,
        3,
        submit_operation(server.workspace.path(), "session-a", "turn-a"),
    )
    .await;
    expect_response(&mut client, 4, steer_operation("session-a", "turn-a")).await;
    expect_error(
        &mut client,
        5,
        steer_operation("session-a", "turn-b"),
        RuntimeIpcErrorCode::SessionInUse,
    )
    .await;
    expect_error(
        &mut client,
        6,
        submit_operation(server.workspace.path(), "session-a", "turn-b"),
        RuntimeIpcErrorCode::SessionInUse,
    )
    .await;

    let calls = handler.calls.lock().unwrap().clone();
    assert_eq!(
        calls
            .iter()
            .filter(|operation| matches!(operation, RuntimeIpcOperation::SteerTurn { .. }))
            .count(),
        1,
        "a mismatched steer must be rejected before reaching the runtime"
    );

    drop(client);
    wait_for_calls(&handler, |calls| {
        calls.iter().any(|call| {
            matches!(
                call,
                RuntimeIpcOperation::CancelTurn { request }
                    if request.session_id == "session-a"
                        && request.turn_id.as_deref() == Some("turn-a")
            )
        })
    })
    .await;
    server.finish().await;
}

#[tokio::test]
async fn steering_rejects_an_invalid_runtime_result_and_closes_the_connection() {
    let handler = Arc::new(FakeHandler {
        invalid_steer_result: true,
        ..FakeHandler::default()
    });
    let server = TestServer::start(server_config(), handler.clone()).await;
    let mut client = server.connect("invalid-steering-result").await;
    expect_response(
        &mut client,
        2,
        restore_operation(server.workspace.path(), "session-a"),
    )
    .await;
    expect_response(
        &mut client,
        3,
        submit_operation(server.workspace.path(), "session-a", "turn-a"),
    )
    .await;
    expect_error(
        &mut client,
        4,
        steer_operation("session-a", "turn-a"),
        RuntimeIpcErrorCode::Internal,
    )
    .await;

    assert!(read_frame(&mut client).await.is_err());
    wait_for_calls(&handler, |calls| {
        calls.iter().any(|call| {
            matches!(
                call,
                RuntimeIpcOperation::CancelTurn { request }
                    if request.session_id == "session-a"
                        && request.turn_id.as_deref() == Some("turn-a")
            )
        })
    })
    .await;
    drop(client);
    server.finish().await;
}

#[tokio::test]
async fn manual_compaction_owns_the_supplied_turn_until_disconnect_cancels_it() {
    let handler = Arc::new(FakeHandler::default());
    let server = TestServer::start(server_config(), handler.clone()).await;
    let mut client = server.connect("compact-controller").await;
    expect_response(
        &mut client,
        2,
        restore_operation(server.workspace.path(), "session-a"),
    )
    .await;
    expect_response(
        &mut client,
        3,
        compact_operation("session-a", "turn-compact-a"),
    )
    .await;
    expect_error(
        &mut client,
        4,
        compact_operation("session-a", "turn-compact-b"),
        RuntimeIpcErrorCode::SessionInUse,
    )
    .await;

    drop(client);
    wait_for_calls(&handler, |calls| {
        let compacted = calls.iter().any(|call| {
            matches!(
                call,
                RuntimeIpcOperation::CompactSession { request }
                    if request.session_id == "session-a"
                        && request.turn_id == "turn-compact-a"
            )
        });
        let cancelled = calls.iter().any(|call| {
            matches!(
                call,
                RuntimeIpcOperation::CancelTurn { request }
                    if request.session_id == "session-a"
                        && request.turn_id.as_deref() == Some("turn-compact-a")
            )
        });
        compacted && cancelled
    })
    .await;
    server.finish().await;
}

#[tokio::test]
async fn mode_update_requires_the_controlled_idle_session() {
    let handler = Arc::new(FakeHandler::default());
    let server = TestServer::start(server_config(), handler.clone()).await;
    let mut client = server.connect("mode-controller").await;

    expect_error(
        &mut client,
        2,
        update_mode_operation("session-a", "ask"),
        RuntimeIpcErrorCode::ControllerRequired,
    )
    .await;
    expect_response(
        &mut client,
        3,
        restore_operation(server.workspace.path(), "session-a"),
    )
    .await;
    expect_error(
        &mut client,
        4,
        update_mode_operation("session-b", "ask"),
        RuntimeIpcErrorCode::SessionMismatch,
    )
    .await;
    expect_response(&mut client, 5, update_mode_operation("session-a", "ask")).await;
    expect_response(
        &mut client,
        6,
        submit_operation(server.workspace.path(), "session-a", "turn-a"),
    )
    .await;
    expect_error(
        &mut client,
        7,
        update_mode_operation("session-a", "Standard"),
        RuntimeIpcErrorCode::SessionInUse,
    )
    .await;

    // Scoped so the guard is provably released before the awaits below.
    let updates = {
        let calls = handler.calls.lock().expect("calls");
        calls
            .iter()
            .filter(|operation| matches!(operation, RuntimeIpcOperation::UpdateSessionMode { .. }))
            .count()
    };
    assert_eq!(
        updates, 1,
        "only the controlled idle-session update reaches the Runtime handler"
    );
    drop(client);
    server.finish().await;
}

#[tokio::test]
async fn timed_out_mode_update_reports_unknown_outcome_and_closes_the_connection() {
    let handler = Arc::new(FakeHandler {
        mode_delay: Some(Duration::from_millis(100)),
        ..FakeHandler::default()
    });
    let mut config = server_config();
    config.request_timeout = Duration::from_millis(20);
    let server = TestServer::start(config, handler).await;
    let mut first = server.connect("mode-timeout").await;
    expect_response(
        &mut first,
        2,
        restore_operation(server.workspace.path(), "session-a"),
    )
    .await;
    expect_error(
        &mut first,
        3,
        update_mode_operation("session-a", "ask"),
        RuntimeIpcErrorCode::OutcomeUnknown,
    )
    .await;

    assert!(read_frame(&mut first).await.is_err());
    let mut second = server.connect("mode-timeout-successor").await;
    expect_response(
        &mut second,
        2,
        restore_operation(server.workspace.path(), "session-a"),
    )
    .await;
    drop(first);
    drop(second);
    server.finish().await;
}

#[tokio::test]
async fn model_update_requires_the_controlled_idle_session() {
    let handler = Arc::new(FakeHandler::default());
    let server = TestServer::start(server_config(), handler.clone()).await;
    let mut client = server.connect("model-controller").await;

    expect_error(
        &mut client,
        2,
        update_model_operation("session-a", "provider/model-a"),
        RuntimeIpcErrorCode::ControllerRequired,
    )
    .await;
    expect_response(
        &mut client,
        3,
        restore_operation(server.workspace.path(), "session-a"),
    )
    .await;
    expect_error(
        &mut client,
        4,
        update_model_operation("session-b", "provider/model-a"),
        RuntimeIpcErrorCode::SessionMismatch,
    )
    .await;
    expect_response(
        &mut client,
        5,
        update_model_operation("session-a", "provider/model-a"),
    )
    .await;
    expect_response(
        &mut client,
        6,
        submit_operation(server.workspace.path(), "session-a", "turn-a"),
    )
    .await;
    expect_error(
        &mut client,
        7,
        update_model_operation("session-a", "provider/model-b"),
        RuntimeIpcErrorCode::SessionInUse,
    )
    .await;

    // Scoped so the guard is provably released before the awaits below.
    let updates = {
        let calls = handler.calls.lock().expect("calls");
        calls
            .iter()
            .filter(|operation| matches!(operation, RuntimeIpcOperation::UpdateSessionModel { .. }))
            .count()
    };
    assert_eq!(
        updates, 1,
        "only the controlled idle-session update reaches the Runtime handler"
    );
    drop(client);
    server.finish().await;
}

#[tokio::test]
async fn timed_out_model_update_reports_unknown_outcome_and_closes_the_connection() {
    let handler = Arc::new(FakeHandler {
        model_delay: Some(Duration::from_millis(100)),
        ..FakeHandler::default()
    });
    let mut config = server_config();
    config.request_timeout = Duration::from_millis(20);
    let server = TestServer::start(config, handler).await;
    let mut first = server.connect("model-timeout").await;
    expect_response(
        &mut first,
        2,
        restore_operation(server.workspace.path(), "session-a"),
    )
    .await;
    expect_error(
        &mut first,
        3,
        update_model_operation("session-a", "provider/model-a"),
        RuntimeIpcErrorCode::OutcomeUnknown,
    )
    .await;

    assert!(read_frame(&mut first).await.is_err());
    let mut second = server.connect("model-timeout-successor").await;
    expect_response(
        &mut second,
        2,
        restore_operation(server.workspace.path(), "session-a"),
    )
    .await;
    drop(first);
    drop(second);
    server.finish().await;
}

#[tokio::test]
async fn rename_requires_the_controlled_idle_session() {
    let handler = Arc::new(FakeHandler::default());
    let server = TestServer::start(server_config(), handler.clone()).await;
    let mut client = server.connect("rename-controller").await;

    expect_error(
        &mut client,
        2,
        rename_operation("session-a", "Auth refactor"),
        RuntimeIpcErrorCode::ControllerRequired,
    )
    .await;
    expect_response(
        &mut client,
        3,
        restore_operation(server.workspace.path(), "session-a"),
    )
    .await;
    expect_error(
        &mut client,
        4,
        rename_operation("session-b", "Other work"),
        RuntimeIpcErrorCode::SessionMismatch,
    )
    .await;
    expect_response(
        &mut client,
        5,
        rename_operation("session-a", "Auth refactor"),
    )
    .await;
    expect_response(
        &mut client,
        6,
        submit_operation(server.workspace.path(), "session-a", "turn-a"),
    )
    .await;
    expect_error(
        &mut client,
        7,
        rename_operation("session-a", "Blocked during turn"),
        RuntimeIpcErrorCode::SessionInUse,
    )
    .await;

    let calls = handler.calls.lock().expect("calls");
    assert_eq!(
        calls
            .iter()
            .filter(|operation| matches!(operation, RuntimeIpcOperation::RenameSession { .. }))
            .count(),
        1,
        "only the controlled idle-session rename reaches the Runtime handler"
    );
    drop(calls);
    drop(client);
    server.finish().await;
}

#[tokio::test]
async fn undo_can_cancel_the_controlled_active_turn_and_clears_its_projection() {
    let handler = Arc::new(FakeHandler::default());
    let server = TestServer::start(server_config(), handler.clone()).await;
    let mut client = server.connect("undo-controller").await;

    expect_response(
        &mut client,
        2,
        restore_operation(server.workspace.path(), "session-a"),
    )
    .await;
    expect_response(
        &mut client,
        3,
        submit_operation(server.workspace.path(), "session-a", "turn-a"),
    )
    .await;
    expect_response(
        &mut client,
        4,
        undo_operation(server.workspace.path(), "session-a"),
    )
    .await;
    expect_response(&mut client, 5, rename_operation("session-a", "After undo")).await;

    let calls = handler.calls.lock().expect("calls");
    assert!(calls
        .iter()
        .any(|operation| matches!(operation, RuntimeIpcOperation::UndoSession { .. })));
    drop(calls);
    drop(client);
    server.finish().await;
}

#[tokio::test]
async fn delete_requires_an_uncontrolled_target_and_an_idle_connection() {
    let handler = Arc::new(FakeHandler::default());
    let server = TestServer::start(server_config(), handler.clone()).await;
    let mut first = server.connect("delete-controller").await;
    let mut second = server.connect("delete-other").await;

    expect_response(
        &mut first,
        2,
        restore_operation(server.workspace.path(), "session-a"),
    )
    .await;
    expect_error(
        &mut first,
        3,
        delete_operation("session-a"),
        RuntimeIpcErrorCode::SessionInUse,
    )
    .await;
    expect_error(
        &mut second,
        2,
        delete_operation("session-a"),
        RuntimeIpcErrorCode::SessionInUse,
    )
    .await;
    expect_response(&mut second, 3, delete_operation("session-b")).await;

    expect_response(
        &mut first,
        4,
        submit_operation(server.workspace.path(), "session-a", "turn-a"),
    )
    .await;
    expect_error(
        &mut first,
        5,
        delete_operation("session-c"),
        RuntimeIpcErrorCode::SessionInUse,
    )
    .await;

    let deletes = handler
        .calls
        .lock()
        .expect("calls")
        .iter()
        .filter(|operation| matches!(operation, RuntimeIpcOperation::DeleteSession { .. }))
        .count();
    assert_eq!(
        deletes, 1,
        "only the uncontrolled idle delete reaches Runtime"
    );

    drop(first);
    drop(second);
    server.finish().await;
}

#[tokio::test]
async fn timed_out_delete_reports_unknown_outcome_and_closes_the_connection() {
    let handler = Arc::new(FakeHandler {
        delete_delay: Some(Duration::from_millis(100)),
        ..FakeHandler::default()
    });
    let mut config = server_config();
    config.request_timeout = Duration::from_millis(20);
    let server = TestServer::start(config, handler).await;
    let mut client = server.connect("delete-timeout").await;

    expect_error(
        &mut client,
        2,
        delete_operation("session-b"),
        RuntimeIpcErrorCode::OutcomeUnknown,
    )
    .await;
    assert!(read_frame(&mut client).await.is_err());

    drop(client);
    server.finish().await;
}

#[tokio::test]
async fn timed_out_rename_reports_unknown_outcome_and_closes_the_connection() {
    let handler = Arc::new(FakeHandler {
        rename_delay: Some(Duration::from_millis(100)),
        ..FakeHandler::default()
    });
    let mut config = server_config();
    config.request_timeout = Duration::from_millis(20);
    let server = TestServer::start(config, handler).await;
    let mut first = server.connect("rename-timeout").await;
    expect_response(
        &mut first,
        2,
        restore_operation(server.workspace.path(), "session-a"),
    )
    .await;
    expect_error(
        &mut first,
        3,
        rename_operation("session-a", "Outcome unknown"),
        RuntimeIpcErrorCode::OutcomeUnknown,
    )
    .await;

    assert!(read_frame(&mut first).await.is_err());
    let mut second = server.connect("rename-timeout-successor").await;
    expect_response(
        &mut second,
        2,
        restore_operation(server.workspace.path(), "session-a"),
    )
    .await;
    drop(first);
    drop(second);
    server.finish().await;
}

#[tokio::test]
async fn timed_out_submit_closes_and_cancels_its_provisional_turn() {
    let handler = Arc::new(FakeHandler {
        submit_delay: Some(Duration::from_millis(100)),
        ..FakeHandler::default()
    });
    let mut config = server_config();
    config.request_timeout = Duration::from_millis(20);
    let server = TestServer::start(config, handler.clone()).await;
    let mut first = server.connect("first-controller").await;
    expect_response(
        &mut first,
        2,
        restore_operation(server.workspace.path(), "session-a"),
    )
    .await;
    expect_error(
        &mut first,
        3,
        submit_operation(server.workspace.path(), "session-a", "turn-a"),
        RuntimeIpcErrorCode::OutcomeUnknown,
    )
    .await;

    wait_for_calls(&handler, |calls| {
        calls.iter().any(|call| {
            matches!(
                call,
                RuntimeIpcOperation::CancelTurn { request }
                    if request.session_id == "session-a"
                        && request.turn_id.as_deref() == Some("turn-a")
            )
        })
    })
    .await;

    let mut second = server.connect("second-controller").await;
    expect_response(
        &mut second,
        2,
        restore_operation(server.workspace.path(), "session-a"),
    )
    .await;
    drop(first);
    drop(second);
    server.finish().await;
}

#[tokio::test]
async fn timed_out_shell_command_closes_and_cancels_its_provisional_turn() {
    let handler = Arc::new(FakeHandler {
        submit_delay: Some(Duration::from_millis(100)),
        ..FakeHandler::default()
    });
    let mut config = server_config();
    config.request_timeout = Duration::from_millis(20);
    let server = TestServer::start(config, handler.clone()).await;
    let mut first = server.connect("shell-controller").await;
    expect_response(
        &mut first,
        2,
        restore_operation(server.workspace.path(), "session-a"),
    )
    .await;
    expect_error(
        &mut first,
        3,
        shell_operation("session-a", "turn-shell-a"),
        RuntimeIpcErrorCode::OutcomeUnknown,
    )
    .await;

    wait_for_calls(&handler, |calls| {
        calls.iter().any(|call| {
            matches!(
                call,
                RuntimeIpcOperation::CancelTurn { request }
                    if request.session_id == "session-a"
                        && request.turn_id.as_deref() == Some("turn-shell-a")
            )
        })
    })
    .await;

    let mut second = server.connect("shell-successor").await;
    expect_response(
        &mut second,
        2,
        restore_operation(server.workspace.path(), "session-a"),
    )
    .await;
    drop(first);
    drop(second);
    server.finish().await;
}

#[tokio::test]
async fn unsettled_disconnect_cancellation_quarantines_the_session_lease() {
    let handler = Arc::new(FakeHandler {
        settle_cancel: false,
        ..FakeHandler::default()
    });
    let server = TestServer::start(server_config(), handler.clone()).await;
    let mut first = server.connect("first-controller").await;
    expect_response(
        &mut first,
        2,
        restore_operation(server.workspace.path(), "session-a"),
    )
    .await;
    expect_response(
        &mut first,
        3,
        submit_operation(server.workspace.path(), "session-a", "turn-a"),
    )
    .await;
    drop(first);

    tokio::time::sleep(Duration::from_millis(30)).await;
    let mut second = server.connect("second-controller").await;
    expect_error(
        &mut second,
        2,
        restore_operation(server.workspace.path(), "session-a"),
        RuntimeIpcErrorCode::SessionInUse,
    )
    .await;

    handler
        .events
        .send(RuntimeIpcEvent::StreamInvalidated {
            reason: crate::RuntimeIpcStreamInvalidationReason::Closed,
        })
        .unwrap();
    drop(second);
    tokio::time::timeout(Duration::from_millis(300), server.finish())
        .await
        .expect("stream invalidation starts the normal idle shutdown window");
}
