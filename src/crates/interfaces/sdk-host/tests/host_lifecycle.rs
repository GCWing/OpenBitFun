use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use openbitfun_agent_runtime::event_queue::{EventQueue, EventQueueConfig};
use openbitfun_agent_runtime::sdk::{
    AgentDialogTurnPort, AgentDialogTurnRequest, AgentEventSource, AgentRuntimeBuilder,
    AgentSessionClosePort, AgentSessionCreateRequest, AgentSessionCreateResult,
    AgentSessionDeleteRequest, AgentSessionListRequest, AgentSessionManagementPort,
    AgentSessionModelPort, AgentSessionModelSelectionUpdateRequest, AgentSessionRestorePort,
    AgentSessionRestoreRequest, AgentSessionRestoreResult, AgentSessionSummary,
    AgentSessionWorkspaceBinding, AgentSessionWorkspaceRequest, AgentSubmissionPort,
    AgentSubmissionRequest, AgentSubmissionResult, AgentTransientSessionDiscardRequest,
    AgentTurnCancellationPort, AgentTurnCancellationRequest, AgentTurnCancellationResult,
    AgentTurnSettlementPort, AgentTurnSettlementRequest, AgentTurnSettlementResult,
    AgentTurnSettlementStatus, DialogSubmitOutcome, PermissionRequest, PermissionRequestManager,
    PermissionRequestSource, PermissionRequestSourceKind, PortError, PortErrorKind, PortResult,
    SessionState,
};
use openbitfun_core_types::ErrorCategory;
use openbitfun_events::{AgenticEvent, ToolEventData, ToolEventIdentity};
use openbitfun_runtime_ports::{
    ClockPort, PermissionAuditRecord, PermissionAuditStorePort, PermissionGrant,
    PermissionReplyStorePort, RuntimeServiceCapability, RuntimeServicePort,
};
use openbitfun_sdk_host::host::{
    ConnectionControl, HostOutput, SdkHostConfig, SdkHostConnection, TemporaryModelInstallError,
    TemporaryModelInstaller,
};
use openbitfun_sdk_host::protocol::{JsonRpcRequest, TemporaryModelConfig, PROTOCOL_VERSION};
use tokio::sync::{mpsc, Notify};
use tokio::time::timeout;

#[derive(Default)]
struct FakeOwner {
    queue: Mutex<Option<Arc<EventQueue>>>,
    created_session_ids: Mutex<Vec<String>>,
    created_model_ids: Mutex<Vec<Option<String>>>,
    cancel_requests: Mutex<Vec<AgentTurnCancellationRequest>>,
    discard_requests: Mutex<Vec<AgentTransientSessionDiscardRequest>>,
    unload_requests: Mutex<Vec<AgentTransientSessionDiscardRequest>>,
    delete_requests: Mutex<Vec<AgentSessionDeleteRequest>>,
    restored_session_ids: Mutex<Vec<String>>,
    updated_models: Mutex<Vec<(String, String)>>,
    settlement_requests: Mutex<Vec<AgentTurnSettlementRequest>>,
    dialog_metadata: Mutex<Vec<serde_json::Map<String, serde_json::Value>>>,
    dialog_requests: Mutex<Vec<AgentDialogTurnRequest>>,
    emit_terminal: bool,
    fail_dialog_submit: bool,
    fail_delete: bool,
    fail_settlement: bool,
    queue_dialog: bool,
    dialog_session_override: Option<String>,
    output_text: Option<String>,
    settlement_output_text: Option<String>,
    settlement_status: Mutex<Option<AgentTurnSettlementStatus>>,
    keep_completed_settlement_after_cancel: bool,
    emit_tool_events: bool,
    block_dialog_submit: bool,
    block_agent_resolution: bool,
    block_first_cancel: bool,
    block_delete: bool,
    block_session_create: bool,
    block_first_session_restore: AtomicBool,
    panic_after_session_create: bool,
    fail_model_update: bool,
    dialog_submit_started: Notify,
    release_dialog_submit: Notify,
    agent_resolution_started: Notify,
    release_agent_resolution: Notify,
    first_cancel_started: Notify,
    release_first_cancel: Notify,
    delete_started: Notify,
    release_delete: Notify,
    session_create_started: Notify,
    release_session_create: Notify,
    session_restore_started: Notify,
    release_session_restore: Notify,
}

impl FakeOwner {
    fn owns_session(&self, session_id: &str) -> bool {
        session_id == "session-fixture"
            || session_id == "transient-fixture"
            || self
                .created_session_ids
                .lock()
                .unwrap()
                .iter()
                .any(|created| created == session_id)
            || self
                .restored_session_ids
                .lock()
                .unwrap()
                .iter()
                .any(|restored| restored == session_id)
    }

    fn last_created_session_id(&self) -> String {
        self.created_session_ids
            .lock()
            .unwrap()
            .last()
            .expect("fixture must have created a Session")
            .clone()
    }

    fn with_queue(queue: Arc<EventQueue>) -> Self {
        Self {
            queue: Mutex::new(Some(queue)),
            emit_terminal: true,
            ..Self::default()
        }
    }

    fn without_terminal(queue: Arc<EventQueue>) -> Self {
        Self {
            queue: Mutex::new(Some(queue)),
            emit_terminal: false,
            ..Self::default()
        }
    }

    fn with_output(queue: Arc<EventQueue>, output_text: String) -> Self {
        Self {
            queue: Mutex::new(Some(queue)),
            emit_terminal: true,
            settlement_output_text: Some(output_text.clone()),
            output_text: Some(output_text),
            ..Self::default()
        }
    }

    fn with_stream_and_settlement_output(
        queue: Arc<EventQueue>,
        output_text: String,
        settlement_output_text: String,
    ) -> Self {
        Self {
            queue: Mutex::new(Some(queue)),
            emit_terminal: true,
            output_text: Some(output_text),
            settlement_output_text: Some(settlement_output_text),
            ..Self::default()
        }
    }

    fn set_settlement_status(&self, status: AgentTurnSettlementStatus) {
        *self.settlement_status.lock().unwrap() = Some(status);
    }

    fn with_tool_events(queue: Arc<EventQueue>) -> Self {
        Self {
            queue: Mutex::new(Some(queue)),
            emit_terminal: true,
            emit_tool_events: true,
            ..Self::default()
        }
    }

    fn failing_dialog(queue: Arc<EventQueue>) -> Self {
        Self {
            queue: Mutex::new(Some(queue)),
            fail_dialog_submit: true,
            ..Self::default()
        }
    }

    fn failing_dialog_and_delete(queue: Arc<EventQueue>) -> Self {
        Self {
            queue: Mutex::new(Some(queue)),
            fail_dialog_submit: true,
            fail_delete: true,
            ..Self::default()
        }
    }

    fn failing_settlement(queue: Arc<EventQueue>) -> Self {
        Self {
            queue: Mutex::new(Some(queue)),
            emit_terminal: true,
            fail_settlement: true,
            ..Self::default()
        }
    }

    fn queued_dialog(queue: Arc<EventQueue>) -> Self {
        Self {
            queue: Mutex::new(Some(queue)),
            queue_dialog: true,
            ..Self::default()
        }
    }

    fn mismatched_dialog(queue: Arc<EventQueue>) -> Self {
        Self {
            queue: Mutex::new(Some(queue)),
            dialog_session_override: Some("different-session".to_string()),
            ..Self::default()
        }
    }

    fn blocking_dialog(queue: Arc<EventQueue>) -> Self {
        Self {
            queue: Mutex::new(Some(queue)),
            block_dialog_submit: true,
            ..Self::default()
        }
    }

    fn blocking_agent_resolution(queue: Arc<EventQueue>) -> Self {
        Self {
            queue: Mutex::new(Some(queue)),
            emit_terminal: true,
            block_agent_resolution: true,
            ..Self::default()
        }
    }

    fn blocking_first_cancel(queue: Arc<EventQueue>) -> Self {
        Self {
            queue: Mutex::new(Some(queue)),
            emit_terminal: false,
            block_first_cancel: true,
            ..Self::default()
        }
    }

    fn blocking_session_create(queue: Arc<EventQueue>) -> Self {
        Self {
            queue: Mutex::new(Some(queue)),
            emit_terminal: false,
            block_session_create: true,
            ..Self::default()
        }
    }

    fn blocking_first_session_restore(queue: Arc<EventQueue>) -> Self {
        Self {
            queue: Mutex::new(Some(queue)),
            emit_terminal: true,
            block_first_session_restore: AtomicBool::new(true),
            ..Self::default()
        }
    }

    fn failing_resume_preparation_and_unload(queue: Arc<EventQueue>) -> Self {
        Self {
            queue: Mutex::new(Some(queue)),
            emit_terminal: true,
            fail_delete: true,
            fail_model_update: true,
            ..Self::default()
        }
    }

    fn panicking_session_create(queue: Arc<EventQueue>, fail_delete: bool) -> Self {
        Self {
            queue: Mutex::new(Some(queue)),
            panic_after_session_create: true,
            fail_delete,
            ..Self::default()
        }
    }

    fn blocking_delete(queue: Arc<EventQueue>) -> Self {
        Self {
            queue: Mutex::new(Some(queue)),
            block_delete: true,
            ..Self::default()
        }
    }
}

#[derive(Default)]
struct FakeTemporaryModelInstaller {
    installed: Mutex<Vec<TemporaryModelConfig>>,
    removed: Mutex<Vec<String>>,
    block_first_install: AtomicBool,
    fail_first_install: AtomicBool,
    install_started: Notify,
    release_install: Notify,
}

impl FakeTemporaryModelInstaller {
    fn blocking_first_install() -> Self {
        Self {
            block_first_install: AtomicBool::new(true),
            ..Self::default()
        }
    }

    fn failing_first_install() -> Self {
        Self {
            fail_first_install: AtomicBool::new(true),
            ..Self::default()
        }
    }
}

#[async_trait]
impl TemporaryModelInstaller for FakeTemporaryModelInstaller {
    async fn install(
        &self,
        model: TemporaryModelConfig,
    ) -> Result<String, TemporaryModelInstallError> {
        self.installed.lock().unwrap().push(model);
        if self.fail_first_install.swap(false, Ordering::AcqRel) {
            return Err(TemporaryModelInstallError::InvalidModel);
        }
        if self.block_first_install.swap(false, Ordering::AcqRel) {
            self.install_started.notify_one();
            self.release_install.notified().await;
        }
        Ok("sdk:openai:resolved".to_string())
    }

    async fn remove(&self, model_id: &str) {
        self.removed.lock().unwrap().push(model_id.to_string());
    }
}

fn fake_installer() -> Arc<dyn TemporaryModelInstaller> {
    Arc::new(FakeTemporaryModelInstaller::default())
}

#[async_trait]
impl AgentSubmissionPort for FakeOwner {
    async fn create_session(
        &self,
        request: AgentSessionCreateRequest,
    ) -> PortResult<AgentSessionCreateResult> {
        if self.block_session_create {
            self.session_create_started.notify_one();
            self.release_session_create.notified().await;
        }
        let session_id = "session-fixture".to_string();
        self.created_model_ids
            .lock()
            .unwrap()
            .push(request.model_id.clone());
        self.created_session_ids
            .lock()
            .unwrap()
            .push(session_id.clone());
        Ok(AgentSessionCreateResult::new(
            session_id,
            request.session_name,
            request.agent_type,
        ))
    }

    async fn create_session_with_id(
        &self,
        session_id: String,
        request: AgentSessionCreateRequest,
    ) -> PortResult<AgentSessionCreateResult> {
        if self.block_session_create {
            self.session_create_started.notify_one();
            self.release_session_create.notified().await;
        }
        self.created_session_ids
            .lock()
            .unwrap()
            .push(session_id.clone());
        self.created_model_ids
            .lock()
            .unwrap()
            .push(request.model_id.clone());
        if self.panic_after_session_create {
            panic!("fixture panics after creating the Session");
        }
        Ok(AgentSessionCreateResult::new(
            session_id,
            request.session_name,
            request.agent_type,
        ))
    }

    async fn create_transient_session_with_id(
        &self,
        session_id: String,
        request: AgentSessionCreateRequest,
    ) -> PortResult<AgentSessionCreateResult> {
        self.create_session_with_id(session_id, request).await
    }

    async fn submit_message(
        &self,
        request: AgentSubmissionRequest,
    ) -> PortResult<AgentSubmissionResult> {
        Ok(AgentSubmissionResult {
            turn_id: request
                .turn_id
                .unwrap_or_else(|| "submission-turn-fixture".to_string()),
            accepted: true,
        })
    }

    async fn resolve_session_agent_type(&self, session_id: &str) -> PortResult<Option<String>> {
        if self.block_agent_resolution {
            self.agent_resolution_started.notify_one();
            self.release_agent_resolution.notified().await;
        }
        if self.owns_session(session_id) {
            Ok(Some("Standard".to_string()))
        } else {
            Err(PortError::new(PortErrorKind::NotFound, "session not found"))
        }
    }
}

#[async_trait]
impl AgentDialogTurnPort for FakeOwner {
    async fn submit_dialog_turn(
        &self,
        request: AgentDialogTurnRequest,
    ) -> PortResult<DialogSubmitOutcome> {
        self.dialog_requests.lock().unwrap().push(request.clone());
        self.dialog_metadata
            .lock()
            .unwrap()
            .push(request.metadata.clone());
        if self.fail_dialog_submit {
            return Err(PortError::new(
                PortErrorKind::Backend,
                "dialog submission failed",
            ));
        }
        if self.block_dialog_submit {
            self.dialog_submit_started.notify_one();
            self.release_dialog_submit.notified().await;
        }
        let session_id = self
            .dialog_session_override
            .clone()
            .unwrap_or_else(|| request.session_id.clone());
        let turn_id = request
            .turn_id
            .clone()
            .unwrap_or_else(|| "turn-fixture".to_string());
        if self.queue_dialog {
            return Ok(DialogSubmitOutcome::Queued {
                session_id: request.session_id,
                turn_id,
            });
        }
        let queue = self.queue.lock().unwrap().clone().unwrap();
        if self.emit_tool_events {
            queue
                .enqueue(
                    AgenticEvent::ToolEvent {
                        session_id: request.session_id.clone(),
                        turn_id: turn_id.clone(),
                        round_id: "round-fixture".to_string(),
                        attempt_id: Some("attempt-fixture".to_string()),
                        attempt_index: Some(0),
                        tool_event: ToolEventData::Started {
                            identity: ToolEventIdentity::direct("tool-fixture", "Read"),
                            params: serde_json::json!({ "path": "must-not-leak.txt" }),
                            timeout_seconds: None,
                        },
                    },
                    None,
                )
                .await
                .unwrap();
            queue
                .enqueue(
                    AgenticEvent::ToolEvent {
                        session_id: request.session_id.clone(),
                        turn_id: turn_id.clone(),
                        round_id: "round-fixture".to_string(),
                        attempt_id: Some("attempt-fixture".to_string()),
                        attempt_index: Some(0),
                        tool_event: ToolEventData::Progress {
                            identity: ToolEventIdentity::direct("tool-fixture", "Read"),
                            message: "must-not-leak-progress".to_string(),
                            percentage: 50.0,
                        },
                    },
                    None,
                )
                .await
                .unwrap();
        }
        queue
            .enqueue(
                AgenticEvent::TextChunk {
                    session_id: request.session_id.clone(),
                    turn_id: turn_id.clone(),
                    round_id: "round-fixture".to_string(),
                    attempt_id: Some("attempt-fixture".to_string()),
                    attempt_index: Some(0),
                    text: self
                        .output_text
                        .clone()
                        .unwrap_or_else(|| "fixture result".to_string()),
                },
                None,
            )
            .await
            .unwrap();
        if self.emit_tool_events {
            queue
                .enqueue(
                    AgenticEvent::ToolEvent {
                        session_id: request.session_id.clone(),
                        turn_id: turn_id.clone(),
                        round_id: "round-fixture".to_string(),
                        attempt_id: Some("attempt-fixture".to_string()),
                        attempt_index: Some(0),
                        tool_event: ToolEventData::Completed {
                            params: None,
                            identity: ToolEventIdentity::direct("tool-fixture", "Read"),
                            result: serde_json::json!({ "content": "must-not-leak" }),
                            result_for_assistant: None,
                            image_attachments: None,
                            duration_ms: 12,
                            queue_wait_ms: None,
                            preflight_ms: None,
                            confirmation_wait_ms: None,
                            execution_ms: Some(12),
                        },
                    },
                    None,
                )
                .await
                .unwrap();
        }
        if self.emit_terminal {
            queue
                .enqueue(
                    AgenticEvent::DialogTurnCompleted {
                        session_id: session_id.clone(),
                        turn_id: turn_id.clone(),
                        total_rounds: 1,
                        total_tools: 0,
                        duration_ms: 1,
                        partial_recovery_reason: None,
                        success: Some(true),
                        finish_reason: Some("stop".to_string()),
                        has_final_response: Some(true),
                    },
                    None,
                )
                .await
                .unwrap();
        }
        Ok(DialogSubmitOutcome::Started {
            session_id,
            turn_id,
        })
    }
}

#[async_trait]
impl AgentTurnSettlementPort for FakeOwner {
    async fn wait_for_turn_settlement(
        &self,
        request: AgentTurnSettlementRequest,
    ) -> PortResult<AgentTurnSettlementResult> {
        self.settlement_requests.lock().unwrap().push(request);
        if self.fail_settlement {
            return Err(PortError::new(
                PortErrorKind::Backend,
                "turn settlement is unknown",
            ));
        }
        let status = self
            .settlement_status
            .lock()
            .unwrap()
            .unwrap_or(AgentTurnSettlementStatus::Completed);
        Ok(AgentTurnSettlementResult {
            status,
            final_response: (status == AgentTurnSettlementStatus::Completed).then(|| {
                self.settlement_output_text
                    .clone()
                    .or_else(|| self.output_text.clone())
                    .unwrap_or_else(|| "fixture result".to_string())
            }),
            finish_reason: Some(
                match status {
                    AgentTurnSettlementStatus::Completed => "stop",
                    AgentTurnSettlementStatus::Failed => "failed",
                    AgentTurnSettlementStatus::Cancelled => "cancelled",
                }
                .to_string(),
            ),
        })
    }
}

#[async_trait]
impl AgentSessionManagementPort for FakeOwner {
    async fn list_sessions(
        &self,
        _request: AgentSessionListRequest,
    ) -> PortResult<Vec<AgentSessionSummary>> {
        Ok(Vec::new())
    }

    async fn delete_session(&self, request: AgentSessionDeleteRequest) -> PortResult<()> {
        self.delete_requests.lock().unwrap().push(request);
        if self.fail_delete {
            return Err(PortError::new(
                PortErrorKind::CleanupRequired,
                "session deletion failed",
            ));
        }
        Ok(())
    }

    async fn resolve_session_workspace_binding(
        &self,
        request: AgentSessionWorkspaceRequest,
    ) -> PortResult<Option<AgentSessionWorkspaceBinding>> {
        if !self.owns_session(&request.session_id) {
            return Ok(None);
        }
        Ok(Some(AgentSessionWorkspaceBinding {
            workspace_id: None,
            workspace_path: "D:/workspace/project".to_string(),
            project_workspace_path: None,
            execution_target: None,
            remote_connection_id: None,
            remote_ssh_host: None,
        }))
    }
}

#[async_trait]
impl AgentSessionRestorePort for FakeOwner {
    async fn restore_session(
        &self,
        request: AgentSessionRestoreRequest,
    ) -> PortResult<AgentSessionRestoreResult> {
        if self
            .block_first_session_restore
            .swap(false, Ordering::AcqRel)
        {
            self.session_restore_started.notify_one();
            self.release_session_restore.notified().await;
        }
        self.restored_session_ids
            .lock()
            .unwrap()
            .push(request.session_id.clone());
        Ok(AgentSessionRestoreResult {
            session: AgentSessionSummary {
                session_id: request.session_id,
                session_name: "Persisted".to_string(),
                agent_type: "Standard".to_string(),
                model_id: Some("sdk:openai:previous".to_string()),
                reasoning_preset: None,
                last_user_dialog_agent_type: None,
                last_submitted_agent_type: None,
                turn_count: 1,
                created_at_ms: 1,
                last_active_at_ms: 2,
            },
            state: SessionState::Idle,
        })
    }
}

#[async_trait]
impl AgentSessionModelPort for FakeOwner {
    async fn update_session_model_selection(
        &self,
        request: AgentSessionModelSelectionUpdateRequest,
    ) -> PortResult<()> {
        self.updated_models
            .lock()
            .unwrap()
            .push((request.session_id, request.selection.model_id));
        if self.fail_model_update {
            return Err(PortError::new(
                PortErrorKind::Backend,
                "model update failed",
            ));
        }
        Ok(())
    }
}

#[derive(Default)]
struct PermissionStore {
    audit: Mutex<Vec<PermissionAuditRecord>>,
}

#[derive(Default)]
struct BlockingPermissionReplyStore {
    audit: Mutex<Vec<PermissionAuditRecord>>,
}

impl RuntimeServicePort for BlockingPermissionReplyStore {
    fn capability(&self) -> RuntimeServiceCapability {
        RuntimeServiceCapability::Permission
    }
}

#[async_trait]
impl PermissionAuditStorePort for BlockingPermissionReplyStore {
    async fn append_permission_audit(&self, record: PermissionAuditRecord) -> PortResult<()> {
        self.audit.lock().unwrap().push(record);
        Ok(())
    }

    async fn list_project_permission_audit(
        &self,
        project_id: &str,
    ) -> PortResult<Vec<PermissionAuditRecord>> {
        Ok(self
            .audit
            .lock()
            .unwrap()
            .iter()
            .filter(|record| record.request.project_id == project_id)
            .cloned()
            .collect())
    }
}

#[async_trait]
impl PermissionReplyStorePort for BlockingPermissionReplyStore {
    async fn commit_permission_reply(
        &self,
        _grants: Vec<PermissionGrant>,
        _audit: Vec<PermissionAuditRecord>,
    ) -> PortResult<()> {
        std::future::pending::<()>().await;
        unreachable!("blocking permission reply store must be cancelled by the Host deadline")
    }
}

impl RuntimeServicePort for PermissionStore {
    fn capability(&self) -> RuntimeServiceCapability {
        RuntimeServiceCapability::Permission
    }
}

#[async_trait]
impl PermissionAuditStorePort for PermissionStore {
    async fn append_permission_audit(&self, record: PermissionAuditRecord) -> PortResult<()> {
        self.audit.lock().unwrap().push(record);
        Ok(())
    }

    async fn list_project_permission_audit(
        &self,
        project_id: &str,
    ) -> PortResult<Vec<PermissionAuditRecord>> {
        Ok(self
            .audit
            .lock()
            .unwrap()
            .iter()
            .filter(|record| record.request.project_id == project_id)
            .cloned()
            .collect())
    }
}

#[async_trait]
impl PermissionReplyStorePort for PermissionStore {
    async fn commit_permission_reply(
        &self,
        _grants: Vec<PermissionGrant>,
        audit: Vec<PermissionAuditRecord>,
    ) -> PortResult<()> {
        self.audit.lock().unwrap().extend(audit);
        Ok(())
    }
}

struct FixedClock;

impl RuntimeServicePort for FixedClock {
    fn capability(&self) -> RuntimeServiceCapability {
        RuntimeServiceCapability::Clock
    }
}

impl ClockPort for FixedClock {
    fn now_unix_millis(&self) -> i64 {
        1_720_000_000_000
    }
}

fn permission_manager() -> Arc<PermissionRequestManager> {
    let store = Arc::new(PermissionStore::default());
    Arc::new(PermissionRequestManager::new(
        store.clone(),
        store,
        Arc::new(FixedClock),
    ))
}

fn blocking_permission_manager() -> Arc<PermissionRequestManager> {
    let store = Arc::new(BlockingPermissionReplyStore::default());
    Arc::new(PermissionRequestManager::new(
        store.clone(),
        store,
        Arc::new(FixedClock),
    ))
}

fn permission_request_fixture(request_id: &str, order: u32, session_id: &str) -> PermissionRequest {
    PermissionRequest {
        request_id: request_id.to_string(),
        round_id: "round-fixture".to_string(),
        order,
        tool_call_id: Some("tool-fixture".to_string()),
        project_path: Some("D:/workspace/project".to_string()),
        project_id: "project-fixture".to_string(),
        session_id: session_id.to_string(),
        agent_id: "Standard".to_string(),
        action: "edit".to_string(),
        resources: vec!["src/lib.rs".to_string()],
        save_resources: Vec::new(),
        source: PermissionRequestSource {
            kind: PermissionRequestSourceKind::ToolCall,
            identity: "edit".to_string(),
        },
        delegation: None,
        display_metadata: serde_json::Map::new(),
    }
}

async fn host_with_query_limit(
    max_active_queries: usize,
) -> (
    SdkHostConnection,
    Arc<FakeOwner>,
    mpsc::Receiver<serde_json::Value>,
) {
    let queue = Arc::new(EventQueue::new(EventQueueConfig::default()));
    let owner = Arc::new(FakeOwner::without_terminal(queue.clone()));
    let runtime = AgentRuntimeBuilder::new()
        .with_submission_port(owner.clone())
        .with_dialog_turn_port(owner.clone())
        .with_cancellation_port(owner.clone())
        .with_turn_settlement_port(owner.clone())
        .with_session_management_port(owner.clone())
        .with_session_close_port(owner.clone())
        .with_permission_request_manager(permission_manager())
        .with_event_source(AgentEventSource::new(queue))
        .build()
        .unwrap();
    let (output, receiver) = mpsc::channel(32);
    (
        SdkHostConnection::new(
            runtime,
            "D:/workspace/project",
            output,
            SdkHostConfig {
                max_active_queries,
                ..SdkHostConfig::default()
            },
            fake_installer(),
        ),
        owner,
        receiver,
    )
}

async fn host_with_output(
    output_text: &str,
    settlement_output_text: &str,
) -> (
    SdkHostConnection,
    Arc<FakeOwner>,
    mpsc::Receiver<serde_json::Value>,
) {
    let queue = Arc::new(EventQueue::new(EventQueueConfig::default()));
    let owner = Arc::new(FakeOwner::with_stream_and_settlement_output(
        queue.clone(),
        output_text.to_string(),
        settlement_output_text.to_string(),
    ));
    let runtime = AgentRuntimeBuilder::new()
        .with_submission_port(owner.clone())
        .with_dialog_turn_port(owner.clone())
        .with_cancellation_port(owner.clone())
        .with_turn_settlement_port(owner.clone())
        .with_session_management_port(owner.clone())
        .with_session_close_port(owner.clone())
        .with_permission_request_manager(permission_manager())
        .with_event_source(AgentEventSource::new(queue))
        .build()
        .unwrap();
    let (output, receiver) = mpsc::channel(32);
    (
        SdkHostConnection::new(
            runtime,
            "D:/workspace/project",
            output,
            SdkHostConfig::default(),
            fake_installer(),
        ),
        owner,
        receiver,
    )
}

#[async_trait]
impl AgentTurnCancellationPort for FakeOwner {
    async fn cancel_turn(
        &self,
        request: AgentTurnCancellationRequest,
    ) -> PortResult<AgentTurnCancellationResult> {
        if !self.keep_completed_settlement_after_cancel {
            self.set_settlement_status(AgentTurnSettlementStatus::Cancelled);
        }
        let cancel_index = {
            let mut requests = self.cancel_requests.lock().unwrap();
            requests.push(request.clone());
            requests.len()
        };
        if self.block_first_cancel && cancel_index == 1 {
            self.first_cancel_started.notify_one();
            self.release_first_cancel.notified().await;
        }
        Ok(AgentTurnCancellationResult {
            session_id: request.session_id,
            turn_id: request.turn_id,
            requested: true,
        })
    }
}

struct FailQueryStartOutput {
    output: mpsc::Sender<serde_json::Value>,
}

#[async_trait]
impl HostOutput for FailQueryStartOutput {
    async fn send(&self, value: serde_json::Value) -> Result<(), ()> {
        if value
            .get("result")
            .and_then(|result| result.get("queryId"))
            .is_some()
        {
            return Err(());
        }
        self.output.send(value).await.map_err(|_| ())
    }
}

struct BlockingSessionCreateOutput {
    output: mpsc::Sender<serde_json::Value>,
    response_visible: Arc<Notify>,
    release_response: Arc<Notify>,
}

#[async_trait]
impl HostOutput for BlockingSessionCreateOutput {
    async fn send(&self, value: serde_json::Value) -> Result<(), ()> {
        let is_session_create =
            value.get("id").and_then(serde_json::Value::as_str) == Some("visible-create");
        self.output.send(value).await.map_err(|_| ())?;
        if is_session_create {
            self.response_visible.notify_one();
            self.release_response.notified().await;
        }
        Ok(())
    }
}

#[async_trait]
impl AgentSessionClosePort for FakeOwner {
    async fn discard_transient_session(
        &self,
        request: AgentTransientSessionDiscardRequest,
    ) -> PortResult<bool> {
        self.discard_requests.lock().unwrap().push(request);
        if self.block_delete {
            self.delete_started.notify_one();
            self.release_delete.notified().await;
        }
        if self.fail_delete {
            return Err(PortError::new(
                PortErrorKind::CleanupRequired,
                "session discard failed",
            ));
        }
        Ok(true)
    }

    async fn unload_persisted_session(
        &self,
        request: AgentTransientSessionDiscardRequest,
    ) -> PortResult<bool> {
        self.unload_requests.lock().unwrap().push(request.clone());
        self.discard_transient_session(request).await
    }
}

fn request(value: serde_json::Value) -> JsonRpcRequest {
    serde_json::from_value(value).unwrap()
}

async fn host() -> (
    SdkHostConnection,
    Arc<FakeOwner>,
    mpsc::Receiver<serde_json::Value>,
) {
    host_with_temporary_model_installer(fake_installer()).await
}

async fn host_with_temporary_model_installer(
    installer: Arc<dyn TemporaryModelInstaller>,
) -> (
    SdkHostConnection,
    Arc<FakeOwner>,
    mpsc::Receiver<serde_json::Value>,
) {
    let queue = Arc::new(EventQueue::new(EventQueueConfig::default()));
    let owner = Arc::new(FakeOwner::with_queue(queue.clone()));
    let runtime = AgentRuntimeBuilder::new()
        .with_submission_port(owner.clone())
        .with_dialog_turn_port(owner.clone())
        .with_cancellation_port(owner.clone())
        .with_turn_settlement_port(owner.clone())
        .with_session_management_port(owner.clone())
        .with_session_close_port(owner.clone())
        .with_session_model_port(owner.clone())
        .with_session_restore_port(owner.clone())
        .with_permission_request_manager(permission_manager())
        .with_event_source(AgentEventSource::new(queue))
        .build()
        .unwrap();
    let (output, receiver) = mpsc::channel(32);
    (
        SdkHostConnection::new(
            runtime,
            "D:/workspace/project",
            output,
            SdkHostConfig::default(),
            installer,
        ),
        owner,
        receiver,
    )
}

async fn host_with_tool_events() -> (
    SdkHostConnection,
    Arc<FakeOwner>,
    mpsc::Receiver<serde_json::Value>,
) {
    let queue = Arc::new(EventQueue::new(EventQueueConfig::default()));
    let owner = Arc::new(FakeOwner::with_tool_events(queue.clone()));
    let runtime = AgentRuntimeBuilder::new()
        .with_submission_port(owner.clone())
        .with_dialog_turn_port(owner.clone())
        .with_cancellation_port(owner.clone())
        .with_turn_settlement_port(owner.clone())
        .with_session_management_port(owner.clone())
        .with_session_close_port(owner.clone())
        .with_permission_request_manager(permission_manager())
        .with_event_source(AgentEventSource::new(queue))
        .build()
        .unwrap();
    let (output, receiver) = mpsc::channel(32);
    (
        SdkHostConnection::new(
            runtime,
            "D:/workspace/project",
            output,
            SdkHostConfig::default(),
            fake_installer(),
        ),
        owner,
        receiver,
    )
}

async fn initialize(host: &SdkHostConnection, output: &mut mpsc::Receiver<serde_json::Value>) {
    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": PROTOCOL_VERSION,
            "clientInfo": { "name": "fixture", "version": "0.1.0" },
            "capabilities": {
                "serverNotifications": true,
                "permissionResponses": true
            },
            "model": {
                "provider": "openai",
                "model": "fixture-model",
                "apiKey": "fixture-secret"
            }
        }
    })))
    .await;
    assert_eq!(output.recv().await.unwrap()["id"], 1);
}

fn temporary_model_initialize_request(id: &str) -> JsonRpcRequest {
    request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "initialize",
        "params": {
            "protocolVersion": PROTOCOL_VERSION,
            "clientInfo": { "name": "fixture", "version": "0.1.0" },
            "capabilities": {
                "serverNotifications": true,
                "permissionResponses": true
            },
            "model": {
                "provider": "openai",
                "model": "fixture-model",
                "apiKey": "fixture-secret"
            }
        }
    }))
}

#[tokio::test]
async fn temporary_model_is_connection_scoped_and_cannot_be_overridden() {
    let queue = Arc::new(EventQueue::new(EventQueueConfig::default()));
    let owner = Arc::new(FakeOwner::with_queue(queue.clone()));
    let runtime = AgentRuntimeBuilder::new()
        .with_submission_port(owner.clone())
        .with_dialog_turn_port(owner.clone())
        .with_cancellation_port(owner.clone())
        .with_turn_settlement_port(owner.clone())
        .with_session_management_port(owner.clone())
        .with_session_close_port(owner.clone())
        .with_permission_request_manager(permission_manager())
        .with_event_source(AgentEventSource::new(queue))
        .build()
        .unwrap();
    let installer = Arc::new(FakeTemporaryModelInstaller::default());
    let (sender, mut output) = mpsc::channel(16);
    let host = SdkHostConnection::new(
        runtime,
        "D:/workspace/project",
        sender,
        SdkHostConfig::default(),
        installer.clone(),
    );

    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "initialize-model",
        "method": "initialize",
        "params": {
            "protocolVersion": PROTOCOL_VERSION,
            "clientInfo": { "name": "fixture", "version": "0.1.0" },
            "capabilities": {
                "serverNotifications": true,
                "permissionResponses": true
            },
            "model": {
                "provider": "openai",
                "model": "fixture-model",
                "apiKey": "fixture-secret"
            }
        }
    })))
    .await;
    let initialized = output.recv().await.unwrap();
    assert_eq!(initialized["result"]["modelId"], "sdk:openai:resolved");

    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "create-with-override",
        "method": "session/create",
        "params": { "model": "attempted-override" }
    })))
    .await;
    assert_eq!(output.recv().await.unwrap()["id"], "create-with-override");

    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "query-with-override",
        "method": "query/start",
        "params": {
            "prompt": "hello",
            "model": "attempted-query-override"
        }
    })))
    .await;
    assert_eq!(output.recv().await.unwrap()["id"], "query-with-override");
    assert_eq!(installer.installed.lock().unwrap().len(), 1);
    assert_eq!(
        owner.created_model_ids.lock().unwrap().as_slice(),
        &[
            Some("sdk:openai:resolved".to_string()),
            Some("sdk:openai:resolved".to_string()),
        ]
    );

    host.shutdown_connection().await;
    host.shutdown_connection().await;
    assert_eq!(
        installer.removed.lock().unwrap().as_slice(),
        &["sdk:openai:resolved".to_string()]
    );
}

#[tokio::test]
async fn concurrent_initialize_installs_temporary_model_once() {
    let installer = Arc::new(FakeTemporaryModelInstaller::blocking_first_install());
    let (host, _owner, mut output) = host_with_temporary_model_installer(installer.clone()).await;
    let first_host = host.clone();
    let first = tokio::spawn(async move {
        first_host
            .handle_request(temporary_model_initialize_request("initialize-first"))
            .await
    });
    installer.install_started.notified().await;

    host.handle_request(temporary_model_initialize_request("initialize-second"))
        .await;
    let second_response = output.recv().await.unwrap();
    installer.release_install.notify_waiters();
    first.await.unwrap();
    let first_response = output.recv().await.unwrap();

    assert_eq!(second_response["id"], "initialize-second");
    assert_eq!(
        second_response["error"]["data"]["code"],
        "already_initialized"
    );
    assert_eq!(first_response["id"], "initialize-first");
    assert_eq!(first_response["result"]["modelId"], "sdk:openai:resolved");
    assert_eq!(installer.installed.lock().unwrap().len(), 1);
    host.shutdown_connection().await;
}

#[tokio::test]
async fn initialize_finishing_after_shutdown_removes_the_installed_model() {
    let installer = Arc::new(FakeTemporaryModelInstaller::blocking_first_install());
    let (host, _owner, mut output) = host_with_temporary_model_installer(installer.clone()).await;
    let initialize_host = host.clone();
    let initialize = tokio::spawn(async move {
        initialize_host
            .handle_request(temporary_model_initialize_request(
                "initialize-during-shutdown",
            ))
            .await
    });
    installer.install_started.notified().await;

    host.shutdown_connection().await;
    installer.release_install.notify_waiters();
    initialize.await.unwrap();
    let response = output.recv().await.unwrap();

    assert_eq!(response["id"], "initialize-during-shutdown");
    assert_eq!(response["error"]["data"]["code"], "cancelled");
    assert!(!host.is_initialized().await);
    assert_eq!(
        installer.removed.lock().unwrap().as_slice(),
        &["sdk:openai:resolved".to_string()]
    );
}

#[tokio::test]
async fn failed_temporary_model_install_rolls_back_for_retry() {
    let installer = Arc::new(FakeTemporaryModelInstaller::failing_first_install());
    let (host, _owner, mut output) = host_with_temporary_model_installer(installer.clone()).await;

    host.handle_request(temporary_model_initialize_request("initialize-invalid"))
        .await;
    let rejected = output.recv().await.unwrap();
    assert_eq!(rejected["error"]["data"]["code"], "invalid_request");

    host.handle_request(temporary_model_initialize_request("initialize-retry"))
        .await;
    let initialized = output.recv().await.unwrap();
    assert_eq!(initialized["result"]["modelId"], "sdk:openai:resolved");
    assert_eq!(installer.installed.lock().unwrap().len(), 2);
    host.shutdown_connection().await;
}

#[tokio::test]
async fn resource_lifecycle_notifications_do_not_create_unaddressable_sessions() {
    let (host, owner, mut output) = host().await;
    initialize(&host, &mut output).await;

    for _ in 0..64 {
        host.handle_request(request(serde_json::json!({
            "jsonrpc": "2.0",
            "method": "session/create",
            "params": {}
        })))
        .await;
    }

    assert!(owner.created_session_ids.lock().unwrap().is_empty());
    assert!(output.try_recv().is_err());

    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "create-after-notifications",
        "method": "session/create",
        "params": {}
    })))
    .await;
    let created = output.recv().await.unwrap();
    assert_eq!(created["id"], "create-after-notifications");
    assert_eq!(created["result"]["lifetime"], "durable");

    host.shutdown_connection().await;
}

#[tokio::test]
async fn initialize_is_required_and_version_mismatch_fails_closed() {
    let (host, _, mut output) = host().await;
    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "query-before-init",
        "method": "query/start",
        "params": { "prompt": "hello" }
    })))
    .await;
    let error = output.recv().await.unwrap();
    assert_eq!(error["error"]["data"]["code"], "not_initialized");

    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "bad-version",
        "method": "initialize",
        "params": {
            "protocolVersion": 99,
            "clientInfo": { "name": "fixture", "version": "0.1.0" },
            "capabilities": {
                "serverNotifications": true,
                "permissionResponses": true
            },
            "model": {
                "provider": "openai",
                "model": "fixture-model",
                "apiKey": "fixture-secret"
            }
        }
    })))
    .await;
    let error = output.recv().await.unwrap();
    assert_eq!(error["error"]["data"]["code"], "version_mismatch");
    assert_eq!(error["error"]["data"]["recovery"], "update_sdk");
}

#[tokio::test]
async fn query_streams_existing_events_and_one_terminal_result() {
    let (host, _, mut output) =
        host_with_output("intermediate tool-round text", "authoritative final answer").await;
    initialize(&host, &mut output).await;

    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "query-1",
        "method": "query/start",
        "params": { "prompt": "hello" }
    })))
    .await;

    let accepted = output.recv().await.unwrap();
    assert_eq!(accepted["result"]["accepted"], true);
    assert_eq!(accepted["result"]["createdSession"], true);
    assert_eq!(accepted["result"]["sessionLifetime"], "connection");
    let query_id = accepted["result"]["queryId"].as_str().unwrap().to_string();

    let event = output.recv().await.unwrap();
    assert_eq!(event["method"], "query/event");
    assert_eq!(event["params"]["queryId"], query_id);
    let operation_id = accepted["result"]["operationId"]
        .as_str()
        .expect("accepted Query operation id")
        .to_string();
    assert_ne!(operation_id, query_id);
    assert_eq!(event["params"]["operationId"], operation_id);
    assert_eq!(event["params"]["event"]["type"], "assistant_text_delta");
    assert_eq!(
        event["params"]["event"]["text"],
        "intermediate tool-round text"
    );

    let result = output.recv().await.unwrap();
    assert_eq!(result["method"], "query/result");
    assert_eq!(result["params"]["queryId"], query_id);
    assert_eq!(result["params"]["operationId"], operation_id);
    assert_eq!(result["params"]["status"], "completed");
    assert_eq!(
        result["params"]["output"]["text"],
        "authoritative final answer"
    );
    assert!(output.try_recv().is_err(), "terminal result must be unique");
}

#[tokio::test]
async fn query_passes_output_schema_to_runtime_and_returns_parsed_json() {
    let (host, owner, mut output) =
        host_with_output(r#"{"summary":"ready"}"#, r#"{"summary":"ready"}"#).await;
    initialize(&host, &mut output).await;
    let schema = serde_json::json!({
        "type": "object",
        "properties": {
            "summary": { "type": "string" }
        },
        "required": ["summary"],
        "additionalProperties": false
    });

    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "query-structured",
        "method": "query/start",
        "params": {
            "prompt": "summarize the repository",
            "outputSchema": schema
        }
    })))
    .await;

    let accepted = output.recv().await.unwrap();
    assert_eq!(accepted["result"]["accepted"], true);
    let submitted = owner.dialog_requests.lock().unwrap();
    assert_eq!(submitted.last().unwrap().output_schema, Some(schema));
    drop(submitted);

    assert_eq!(output.recv().await.unwrap()["method"], "query/event");
    let result = output.recv().await.unwrap();
    assert_eq!(result["method"], "query/result");
    assert_eq!(result["params"]["status"], "completed");
    assert_eq!(result["params"]["output"]["text"], r#"{"summary":"ready"}"#);
    assert_eq!(
        result["params"]["output"]["structured"],
        serde_json::json!({ "summary": "ready" })
    );
}

#[tokio::test]
async fn query_rejects_a_non_object_output_schema_before_submission() {
    let (host, owner, mut output) = host().await;
    initialize(&host, &mut output).await;

    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "query-invalid-schema",
        "method": "query/start",
        "params": {
            "prompt": "summarize the repository",
            "outputSchema": ["not", "an", "object"]
        }
    })))
    .await;

    let rejected = output.recv().await.unwrap();
    assert_eq!(rejected["error"]["data"]["code"], "invalid_request");
    assert!(owner.dialog_requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn query_fails_when_structured_output_is_not_json() {
    let (host, _, mut output) = host_with_output("not json", "not json").await;
    initialize(&host, &mut output).await;

    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "query-invalid-output",
        "method": "query/start",
        "params": {
            "prompt": "summarize the repository",
            "outputSchema": { "type": "object" }
        }
    })))
    .await;

    let accepted = output.recv().await.unwrap();
    assert_eq!(accepted["result"]["accepted"], true);
    assert_eq!(output.recv().await.unwrap()["method"], "query/event");
    let result = output.recv().await.unwrap();
    assert_eq!(result["params"]["status"], "failed");
    assert_eq!(result["params"]["output"]["text"], "not json");
    assert!(result["params"]["output"].get("structured").is_none());
    assert_eq!(result["params"]["error"]["data"]["code"], "internal");
    assert_eq!(
        result["params"]["error"]["data"]["operationId"],
        result["params"]["operationId"]
    );
}

#[tokio::test]
async fn query_maps_local_image_paths_to_existing_runtime_attachments() {
    let (host, owner, mut output) = host().await;
    initialize(&host, &mut output).await;

    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "query-image",
        "method": "query/start",
        "params": {
            "prompt": "",
            "images": ["screenshots/fixture.jpg"]
        }
    })))
    .await;

    let accepted = output.recv().await.unwrap();
    assert_eq!(accepted["result"]["accepted"], true);
    let requests = owner.dialog_requests.lock().unwrap();
    let request = requests.last().expect("submitted dialog request");
    assert!(request.message.is_empty());
    let attachment = &request.attachments[0];
    assert_eq!(attachment.kind, "remote_image");
    assert_eq!(attachment.metadata["mimeType"], "image/jpeg");
    assert_eq!(
        PathBuf::from(
            attachment.metadata["imagePath"]
                .as_str()
                .expect("local image path")
        ),
        PathBuf::from("D:/workspace/project").join("screenshots/fixture.jpg")
    );
}

#[tokio::test]
async fn query_result_aggregates_usage_for_its_turn() {
    let (host, owner, mut output) = host_with_query_limit(1).await;
    initialize(&host, &mut output).await;

    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "query-usage",
        "method": "query/start",
        "params": { "prompt": "hello" }
    })))
    .await;

    let accepted = output.recv().await.unwrap();
    assert_eq!(accepted["result"]["turnId"], "turn-fixture");
    assert_eq!(output.recv().await.unwrap()["method"], "query/event");
    let session_id = accepted["result"]["sessionId"].as_str().unwrap();
    let queue = owner.queue.lock().unwrap().clone().unwrap();
    for event in [
        usage_event(session_id, "turn-fixture", 100, Some(25), 125, Some(40)),
        usage_event(session_id, "another-turn", 900, Some(90), 990, Some(80)),
        usage_event(session_id, "turn-fixture", 200, Some(50), 250, Some(80)),
        AgenticEvent::DialogTurnCompleted {
            session_id: session_id.to_string(),
            turn_id: "turn-fixture".to_string(),
            total_rounds: 2,
            total_tools: 0,
            duration_ms: 1,
            partial_recovery_reason: None,
            success: Some(true),
            finish_reason: Some("stop".to_string()),
            has_final_response: Some(true),
        },
    ] {
        queue.enqueue(event, None).await.unwrap();
    }

    let result = output.recv().await.unwrap();
    assert_eq!(result["method"], "query/result");
    assert_eq!(result["params"]["usage"]["inputTokens"], 300);
    assert_eq!(result["params"]["usage"]["outputTokens"], 75);
    assert_eq!(result["params"]["usage"]["totalTokens"], 375);
    assert_eq!(result["params"]["usage"]["cachedTokens"], 120);
}

fn usage_event(
    session_id: &str,
    turn_id: &str,
    input_tokens: usize,
    output_tokens: Option<usize>,
    total_tokens: usize,
    cached_tokens: Option<usize>,
) -> AgenticEvent {
    AgenticEvent::TokenUsageUpdated {
        session_id: session_id.to_string(),
        turn_id: turn_id.to_string(),
        model_config_id: "model-config".to_string(),
        effective_model_name: "provider-model".to_string(),
        input_tokens,
        output_tokens,
        total_tokens,
        max_context_tokens: Some(200_000),
        is_subagent: false,
        cached_tokens,
        token_details: None,
    }
}

#[tokio::test]
async fn query_projects_safe_tool_activity_without_raw_inputs_or_results() {
    let (host, _, mut output) = host_with_tool_events().await;
    initialize(&host, &mut output).await;

    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "query-tools",
        "method": "query/start",
        "params": { "prompt": "read a file" }
    })))
    .await;

    let accepted = output.recv().await.unwrap();
    let started = output.recv().await.unwrap();
    let progress = output.recv().await.unwrap();
    let text = output.recv().await.unwrap();
    let completed = output.recv().await.unwrap();
    let result = output.recv().await.unwrap();

    assert_eq!(started["params"]["sequence"], 1);
    assert_eq!(started["params"]["event"]["type"], "tool_event");
    assert_eq!(started["params"]["event"]["toolCallId"], "tool-fixture");
    assert_eq!(started["params"]["event"]["toolName"], "Read");
    assert_eq!(started["params"]["event"]["status"], "started");
    assert!(started["params"]["event"].get("params").is_none());

    assert_eq!(progress["params"]["sequence"], 2);
    assert_eq!(progress["params"]["event"]["status"], "progress");
    assert_eq!(progress["params"]["event"]["progress"], 50.0);
    assert!(!serde_json::to_string(&progress)
        .unwrap()
        .contains("must-not-leak-progress"));
    assert_eq!(text["params"]["sequence"], 3);
    assert_eq!(text["params"]["event"]["type"], "assistant_text_delta");
    assert_eq!(completed["params"]["sequence"], 4);
    assert_eq!(completed["params"]["event"]["status"], "completed");
    assert_eq!(completed["params"]["event"]["durationMs"], 12);
    assert!(completed["params"]["event"].get("result").is_none());

    assert_eq!(result["params"]["status"], "completed");
    assert_eq!(result["params"]["queryId"], accepted["result"]["queryId"]);
    assert_eq!(result["params"]["output"]["text"], "fixture result");
}

#[tokio::test]
async fn escaped_query_output_fails_before_exceeding_the_wire_budget() {
    let queue = Arc::new(EventQueue::new(EventQueueConfig::default()));
    let owner = Arc::new(FakeOwner::with_output(
        queue.clone(),
        "\\".repeat(384 * 1024 + 1),
    ));
    let runtime = AgentRuntimeBuilder::new()
        .with_submission_port(owner.clone())
        .with_dialog_turn_port(owner.clone())
        .with_cancellation_port(owner.clone())
        .with_turn_settlement_port(owner.clone())
        .with_session_management_port(owner.clone())
        .with_session_close_port(owner.clone())
        .with_permission_request_manager(permission_manager())
        .with_event_source(AgentEventSource::new(queue))
        .build()
        .unwrap();
    let (sender, mut output) = mpsc::channel(16);
    let host = SdkHostConnection::new(
        runtime,
        "D:/workspace/project",
        sender,
        SdkHostConfig::default(),
        fake_installer(),
    );
    initialize(&host, &mut output).await;

    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "query-output-limit",
        "method": "query/start",
        "params": { "prompt": "produce excessive output" }
    })))
    .await;

    assert_eq!(output.recv().await.unwrap()["id"], "query-output-limit");
    let result = output.recv().await.unwrap();
    assert_eq!(result["method"], "query/result");
    assert_eq!(result["params"]["status"], "failed");
    assert_eq!(result["params"]["error"]["data"]["code"], "overloaded");
    assert_eq!(result["params"]["output"]["text"], "");
}

#[tokio::test]
async fn host_output_failure_wins_when_runtime_completed_before_cancellation() {
    let queue = Arc::new(EventQueue::new(EventQueueConfig::default()));
    let owner = Arc::new(FakeOwner {
        queue: Mutex::new(Some(queue.clone())),
        emit_terminal: true,
        output_text: Some("\\".repeat(384 * 1024 + 1)),
        settlement_output_text: Some("authoritative final answer".to_string()),
        keep_completed_settlement_after_cancel: true,
        ..FakeOwner::default()
    });
    let runtime = AgentRuntimeBuilder::new()
        .with_submission_port(owner.clone())
        .with_dialog_turn_port(owner.clone())
        .with_cancellation_port(owner.clone())
        .with_turn_settlement_port(owner.clone())
        .with_session_management_port(owner.clone())
        .with_session_close_port(owner.clone())
        .with_permission_request_manager(permission_manager())
        .with_event_source(AgentEventSource::new(queue))
        .build()
        .unwrap();
    let (sender, mut output) = mpsc::channel(16);
    let host = SdkHostConnection::new(
        runtime,
        "D:/workspace/project",
        sender,
        SdkHostConfig::default(),
        fake_installer(),
    );
    initialize(&host, &mut output).await;

    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "query-output-race",
        "method": "query/start",
        "params": { "prompt": "produce excessive output" }
    })))
    .await;

    assert_eq!(output.recv().await.unwrap()["id"], "query-output-race");
    let result = output.recv().await.unwrap();
    assert_eq!(result["method"], "query/result");
    assert_eq!(result["params"]["status"], "failed");
    assert_eq!(result["params"]["error"]["data"]["code"], "overloaded");
}

#[tokio::test]
async fn cancellation_after_terminal_result_is_idempotent_with_full_query_identity() {
    let (host, _, mut output) = host().await;
    initialize(&host, &mut output).await;
    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "query-before-late-cancel",
        "method": "query/start",
        "params": { "prompt": "hello" }
    })))
    .await;
    let accepted = output.recv().await.unwrap();
    let query_id = accepted["result"]["queryId"].as_str().unwrap().to_string();
    let session_id = accepted["result"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();
    let turn_id = accepted["result"]["turnId"].as_str().unwrap().to_string();
    let operation_id = accepted["result"]["operationId"]
        .as_str()
        .unwrap()
        .to_string();
    while output.recv().await.unwrap()["method"] != "query/result" {}

    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "late-cancel",
        "method": "query/cancel",
        "params": {
            "queryId": query_id,
            "sessionId": session_id,
            "turnId": turn_id,
            "operationId": operation_id
        }
    })))
    .await;
    let cancelled = output.recv().await.unwrap();
    assert_eq!(cancelled["id"], "late-cancel");
    assert_eq!(cancelled["result"]["queryId"], query_id);
    assert_eq!(cancelled["result"]["operationId"], operation_id);
    assert_eq!(cancelled["result"]["requested"], false);
}

#[tokio::test]
async fn cancellation_timeout_reports_unknown_outcome_for_the_exact_operation() {
    let queue = Arc::new(EventQueue::new(EventQueueConfig::default()));
    let owner = Arc::new(FakeOwner::blocking_first_cancel(queue.clone()));
    let runtime = AgentRuntimeBuilder::new()
        .with_submission_port(owner.clone())
        .with_dialog_turn_port(owner.clone())
        .with_cancellation_port(owner.clone())
        .with_turn_settlement_port(owner.clone())
        .with_session_management_port(owner.clone())
        .with_session_close_port(owner.clone())
        .with_permission_request_manager(permission_manager())
        .with_event_source(AgentEventSource::new(queue))
        .build()
        .unwrap();
    let (sender, mut output) = mpsc::channel(16);
    let host = SdkHostConnection::new(
        runtime,
        "D:/workspace/project",
        sender,
        SdkHostConfig::default(),
        fake_installer(),
    );
    initialize(&host, &mut output).await;

    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "query-before-cancel-timeout",
        "method": "query/start",
        "params": { "prompt": "hello" }
    })))
    .await;
    let accepted = output.recv().await.unwrap();
    let query_id = accepted["result"]["queryId"].as_str().unwrap().to_string();
    let session_id = accepted["result"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();
    let turn_id = accepted["result"]["turnId"].as_str().unwrap().to_string();
    let operation_id = accepted["result"]["operationId"]
        .as_str()
        .unwrap()
        .to_string();
    let expected_operation_id = operation_id.clone();

    let cancel_host = host.clone();
    let cancel = tokio::spawn(async move {
        cancel_host
            .handle_request(request(serde_json::json!({
                "jsonrpc": "2.0",
                "id": "cancel-timeout",
                "method": "query/cancel",
                "params": {
                    "queryId": query_id,
                    "sessionId": session_id,
                    "turnId": turn_id,
                    "operationId": operation_id
                }
            })))
            .await
    });
    owner.first_cancel_started.notified().await;
    let cancellation = loop {
        let message = output.recv().await.unwrap();
        if message["id"] == "cancel-timeout" {
            break message;
        }
    };
    assert_eq!(cancellation["error"]["data"]["code"], "timeout");
    assert_eq!(cancellation["error"]["data"]["outcomeCertainty"], "unknown");
    assert_eq!(
        cancellation["error"]["data"]["operationId"],
        expected_operation_id
    );
    assert_eq!(cancel.await.unwrap(), ConnectionControl::Continue);
    host.shutdown_connection().await;
}

#[tokio::test]
async fn query_on_created_session_preserves_durable_lifetime() {
    let (host, _, mut output) = host().await;
    initialize(&host, &mut output).await;

    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "create-1",
        "method": "session/create",
        "params": {}
    })))
    .await;
    let created = output.recv().await.unwrap();
    assert_eq!(created["result"]["lifetime"], "durable");
    let session_id = created["result"]["sessionId"].as_str().unwrap();

    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "query-1",
        "method": "query/start",
        "params": {
            "prompt": "hello",
            "sessionId": session_id
        }
    })))
    .await;

    let accepted = output.recv().await.unwrap();
    assert_eq!(accepted["id"], "query-1");
    assert_eq!(accepted["result"]["createdSession"], false);
    assert_eq!(accepted["result"]["sessionLifetime"], "durable");

    host.shutdown_connection().await;
}

#[tokio::test]
async fn persisted_session_resume_rebinds_the_connection_model_and_unloads_on_close() {
    let (host, owner, mut output) = host().await;
    initialize(&host, &mut output).await;
    let session_id = "00000000-0000-4000-8000-000000000001";

    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "resume-1",
        "method": "session/resume",
        "params": { "sessionId": session_id }
    })))
    .await;
    let resumed = output.recv().await.unwrap();
    assert_eq!(resumed["result"]["sessionId"], session_id);
    assert_eq!(resumed["result"]["lifetime"], "durable");
    assert_eq!(
        owner.updated_models.lock().unwrap().as_slice(),
        &[(session_id.to_string(), "sdk:openai:resolved".to_string())]
    );

    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "close-resumed",
        "method": "session/close",
        "params": { "sessionId": session_id }
    })))
    .await;
    assert_eq!(output.recv().await.unwrap()["result"]["unloaded"], true);
    assert_eq!(owner.unload_requests.lock().unwrap().len(), 1);

    host.shutdown_connection().await;
}

#[tokio::test]
async fn concurrent_resume_of_the_same_session_is_rejected_while_attach_is_in_flight() {
    let queue = Arc::new(EventQueue::new(EventQueueConfig::default()));
    let owner = Arc::new(FakeOwner::blocking_first_session_restore(queue.clone()));
    let runtime = AgentRuntimeBuilder::new()
        .with_submission_port(owner.clone())
        .with_dialog_turn_port(owner.clone())
        .with_cancellation_port(owner.clone())
        .with_turn_settlement_port(owner.clone())
        .with_session_management_port(owner.clone())
        .with_session_close_port(owner.clone())
        .with_session_model_port(owner.clone())
        .with_session_restore_port(owner.clone())
        .with_permission_request_manager(permission_manager())
        .with_event_source(AgentEventSource::new(queue))
        .build()
        .unwrap();
    let (sender, mut output) = mpsc::channel(16);
    let host = SdkHostConnection::new(
        runtime,
        "D:/workspace/project",
        sender,
        SdkHostConfig::default(),
        fake_installer(),
    );
    initialize(&host, &mut output).await;
    let session_id = "00000000-0000-4000-8000-000000000002";

    let first_host = host.clone();
    let first = tokio::spawn(async move {
        first_host
            .handle_request(request(serde_json::json!({
                "jsonrpc": "2.0",
                "id": "resume-first",
                "method": "session/resume",
                "params": { "sessionId": session_id }
            })))
            .await
    });
    owner.session_restore_started.notified().await;

    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "resume-second",
        "method": "session/resume",
        "params": { "sessionId": session_id }
    })))
    .await;
    let rejected = output.recv().await.unwrap();
    assert_eq!(rejected["id"], "resume-second");
    assert_eq!(rejected["error"]["data"]["code"], "invalid_request");

    owner.release_session_restore.notify_one();
    assert_eq!(first.await.unwrap(), ConnectionControl::Continue);
    let resumed = output.recv().await.unwrap();
    assert_eq!(resumed["id"], "resume-first");
    assert_eq!(resumed["result"]["sessionId"], session_id);
    assert_eq!(owner.restored_session_ids.lock().unwrap().len(), 1);

    host.shutdown_connection().await;
}

#[tokio::test]
async fn failed_resume_compensation_blocks_new_work_and_retries_unload_on_shutdown() {
    let queue = Arc::new(EventQueue::new(EventQueueConfig::default()));
    let owner = Arc::new(FakeOwner::failing_resume_preparation_and_unload(
        queue.clone(),
    ));
    let runtime = AgentRuntimeBuilder::new()
        .with_submission_port(owner.clone())
        .with_dialog_turn_port(owner.clone())
        .with_cancellation_port(owner.clone())
        .with_turn_settlement_port(owner.clone())
        .with_session_management_port(owner.clone())
        .with_session_close_port(owner.clone())
        .with_session_model_port(owner.clone())
        .with_session_restore_port(owner.clone())
        .with_permission_request_manager(permission_manager())
        .with_event_source(AgentEventSource::new(queue))
        .build()
        .unwrap();
    let (sender, mut output) = mpsc::channel(16);
    let host = SdkHostConnection::new(
        runtime,
        "D:/workspace/project",
        sender,
        SdkHostConfig::default(),
        fake_installer(),
    );
    initialize(&host, &mut output).await;
    let session_id = "00000000-0000-4000-8000-000000000003";

    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "resume-failed-cleanup",
        "method": "session/resume",
        "params": { "sessionId": session_id }
    })))
    .await;
    let resume_error = output.recv().await.unwrap();
    assert_eq!(resume_error["error"]["data"]["code"], "cleanup_required");
    assert_eq!(owner.unload_requests.lock().unwrap().len(), 1);

    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "blocked-after-failed-cleanup",
        "method": "session/create",
        "params": {}
    })))
    .await;
    let blocked = output.recv().await.unwrap();
    assert_eq!(blocked["error"]["data"]["code"], "cleanup_required");

    host.shutdown_connection().await;
    assert_eq!(owner.unload_requests.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn dialog_session_identity_mismatch_releases_the_requested_session_reservation() {
    let queue = Arc::new(EventQueue::new(EventQueueConfig::default()));
    let owner = Arc::new(FakeOwner::mismatched_dialog(queue.clone()));
    let runtime = AgentRuntimeBuilder::new()
        .with_submission_port(owner.clone())
        .with_dialog_turn_port(owner.clone())
        .with_cancellation_port(owner.clone())
        .with_turn_settlement_port(owner.clone())
        .with_session_management_port(owner.clone())
        .with_session_close_port(owner.clone())
        .with_permission_request_manager(permission_manager())
        .with_event_source(AgentEventSource::new(queue))
        .build()
        .unwrap();
    let (sender, mut output) = mpsc::channel(16);
    let host = SdkHostConnection::new(
        runtime,
        "D:/workspace/project",
        sender,
        SdkHostConfig::default(),
        fake_installer(),
    );
    initialize(&host, &mut output).await;

    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "create-mismatch",
        "method": "session/create",
        "params": {}
    })))
    .await;
    let created = output.recv().await.unwrap();
    let session_id = created["result"]["sessionId"].as_str().unwrap();

    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "query-mismatch",
        "method": "query/start",
        "params": { "prompt": "hello", "sessionId": session_id }
    })))
    .await;
    let rejected = output.recv().await.unwrap();
    assert_eq!(rejected["id"], "query-mismatch");
    assert_eq!(rejected["error"]["data"]["code"], "internal");

    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "close-after-mismatch",
        "method": "session/close",
        "params": { "sessionId": session_id }
    })))
    .await;
    let closed = output.recv().await.unwrap();
    assert_eq!(closed["id"], "close-after-mismatch");
    assert_eq!(closed["result"]["unloaded"], true);
}

#[tokio::test]
async fn cancel_close_and_shutdown_use_existing_runtime_owners() {
    let (host, owner, mut output) = host().await;
    initialize(&host, &mut output).await;
    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "query-1",
        "method": "query/start",
        "params": { "prompt": "hello" }
    })))
    .await;
    let accepted = output.recv().await.unwrap();
    let query_id = accepted["result"]["queryId"].as_str().unwrap();
    let session_id = accepted["result"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();
    let turn_id = accepted["result"]["turnId"].as_str().unwrap();
    let operation_id = accepted["result"]["operationId"].as_str().unwrap();

    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "cancel-1",
        "method": "query/cancel",
        "params": {
            "queryId": query_id,
            "sessionId": session_id,
            "turnId": turn_id,
            "operationId": operation_id
        }
    })))
    .await;
    while output.recv().await.unwrap()["id"] != "cancel-1" {}
    assert_eq!(owner.cancel_requests.lock().unwrap().len(), 1);

    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "close-1",
        "method": "session/close",
        "params": { "sessionId": session_id, "waitTimeoutMs": 1234 }
    })))
    .await;
    while output.recv().await.unwrap()["id"] != "close-1" {}
    // Scoped so the guard is provably released before the awaits below.
    {
        let discard_requests = owner.discard_requests.lock().unwrap();
        assert_eq!(discard_requests.len(), 1);
        assert_eq!(discard_requests[0].wait_timeout_ms, 1234);
    }

    let control = host
        .handle_request(request(serde_json::json!({
            "jsonrpc": "2.0",
            "id": "shutdown-1",
            "method": "shutdown",
            "params": {}
        })))
        .await;
    assert_eq!(control, ConnectionControl::Shutdown);
    assert_eq!(output.recv().await.unwrap()["id"], "shutdown-1");
}

#[tokio::test]
async fn uncertain_session_close_cleanup_requires_host_restart() {
    let queue = Arc::new(EventQueue::new(EventQueueConfig::default()));
    let owner = Arc::new(FakeOwner::blocking_delete(queue.clone()));
    let runtime = AgentRuntimeBuilder::new()
        .with_submission_port(owner.clone())
        .with_dialog_turn_port(owner.clone())
        .with_cancellation_port(owner.clone())
        .with_turn_settlement_port(owner.clone())
        .with_session_management_port(owner.clone())
        .with_session_close_port(owner.clone())
        .with_permission_request_manager(permission_manager())
        .with_event_source(AgentEventSource::new(queue))
        .build()
        .unwrap();
    let (sender, mut output) = mpsc::channel(16);
    let host = SdkHostConnection::new(
        runtime,
        "D:/workspace/project",
        sender,
        SdkHostConfig::default(),
        fake_installer(),
    );
    initialize(&host, &mut output).await;
    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "create-before-close-timeout",
        "method": "session/create",
        "params": {}
    })))
    .await;
    let created = output.recv().await.unwrap();
    let session_id = created["result"]["sessionId"].as_str().unwrap();

    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "close-timeout",
        "method": "session/close",
        "params": { "sessionId": session_id, "waitTimeoutMs": 1 }
    })))
    .await;
    let close_error = output.recv().await.unwrap();
    assert_eq!(close_error["error"]["data"]["code"], "cleanup_required");
    assert_eq!(close_error["error"]["data"]["retryable"], false);
    assert_eq!(close_error["error"]["data"]["outcomeCertainty"], "unknown");
    assert_eq!(close_error["error"]["data"]["recovery"], "restart_host");

    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "rejected-after-close-timeout",
        "method": "session/create",
        "params": {}
    })))
    .await;
    assert_eq!(
        output.recv().await.unwrap()["error"]["data"]["code"],
        "cleanup_required"
    );
}

#[tokio::test]
async fn active_query_capacity_fails_closed_with_typed_overload() {
    let (host, _, mut output) = host_with_query_limit(1).await;
    initialize(&host, &mut output).await;

    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "query-1",
        "method": "query/start",
        "params": { "prompt": "first" }
    })))
    .await;
    assert_eq!(output.recv().await.unwrap()["id"], "query-1");

    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "query-2",
        "method": "query/start",
        "params": { "prompt": "second" }
    })))
    .await;
    let mut response = output.recv().await.unwrap();
    while response.get("id").is_none() {
        response = output.recv().await.unwrap();
    }
    assert_eq!(response["id"], "query-2");
    assert_eq!(response["error"]["data"]["code"], "overloaded");
    assert_eq!(response["error"]["data"]["stage"], "query");
    assert_eq!(response["error"]["data"]["recovery"], "retry");
}

#[tokio::test]
async fn cancellation_remains_available_when_data_request_capacity_is_exhausted() {
    let queue = Arc::new(EventQueue::new(EventQueueConfig::default()));
    let owner = Arc::new(FakeOwner::blocking_session_create(queue.clone()));
    let runtime = AgentRuntimeBuilder::new()
        .with_submission_port(owner.clone())
        .with_dialog_turn_port(owner.clone())
        .with_cancellation_port(owner.clone())
        .with_turn_settlement_port(owner.clone())
        .with_session_management_port(owner.clone())
        .with_session_close_port(owner.clone())
        .with_permission_request_manager(permission_manager())
        .with_event_source(AgentEventSource::new(queue))
        .build()
        .unwrap();
    let (sender, mut output) = mpsc::channel(16);
    let host = SdkHostConnection::new(
        runtime,
        "D:/workspace/project",
        sender,
        SdkHostConfig {
            max_in_flight_requests: 1,
            max_in_flight_control_requests: 1,
            ..SdkHostConfig::default()
        },
        fake_installer(),
    );
    initialize(&host, &mut output).await;

    let create_host = host.clone();
    let create = tokio::spawn(async move {
        create_host
            .handle_request(request(serde_json::json!({
                "jsonrpc": "2.0",
                "id": "blocked-create",
                "method": "session/create",
                "params": {}
            })))
            .await
    });
    owner.session_create_started.notified().await;

    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "cancel-while-data-busy",
        "method": "query/cancel",
        "params": {
            "queryId": "missing-query",
            "sessionId": "missing-session",
            "turnId": "missing-turn",
            "operationId": "missing-operation"
        }
    })))
    .await;
    let cancellation = output.recv().await.unwrap();
    assert_eq!(cancellation["id"], "cancel-while-data-busy");
    assert_eq!(cancellation["result"]["requested"], false);
    assert_eq!(cancellation["result"]["operationId"], "missing-operation");

    owner.release_session_create.notify_one();
    assert_eq!(create.await.unwrap(), ConnectionControl::Continue);
    assert_eq!(output.recv().await.unwrap()["id"], "blocked-create");
    host.shutdown_connection().await;
}

#[tokio::test]
async fn connection_loss_unloads_owned_durable_sessions_through_core_port() {
    let (host, owner, mut output) = host().await;
    initialize(&host, &mut output).await;
    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "create-1",
        "method": "session/create",
        "params": { "sessionName": "owned by connection" }
    })))
    .await;
    let created = output.recv().await.unwrap();
    assert_eq!(created["id"], "create-1");
    assert_eq!(created["result"]["lifetime"], "durable");
    let session_id = created["result"]["sessionId"].as_str().unwrap();

    host.shutdown_connection().await;

    let requests = owner.unload_requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].session_id, session_id);
}

#[tokio::test]
async fn query_start_does_not_implicitly_resume_a_durable_session() {
    let (host, owner, mut output) = host().await;
    initialize(&host, &mut output).await;
    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "query-durable",
        "method": "query/start",
        "params": {
            "prompt": "use an existing durable Session",
            "sessionId": "session-fixture"
        }
    })))
    .await;

    let rejected = output.recv().await.unwrap();
    assert_eq!(rejected["id"], "query-durable");
    assert_eq!(rejected["error"]["data"]["code"], "capability_unavailable");

    host.shutdown_connection().await;

    assert!(owner.discard_requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn visible_session_create_response_commits_before_immediate_close() {
    let queue = Arc::new(EventQueue::new(EventQueueConfig::default()));
    let owner = Arc::new(FakeOwner::with_queue(queue.clone()));
    let runtime = AgentRuntimeBuilder::new()
        .with_submission_port(owner.clone())
        .with_dialog_turn_port(owner.clone())
        .with_cancellation_port(owner.clone())
        .with_turn_settlement_port(owner.clone())
        .with_session_management_port(owner.clone())
        .with_session_close_port(owner.clone())
        .with_permission_request_manager(permission_manager())
        .with_event_source(AgentEventSource::new(queue))
        .build()
        .unwrap();
    let (sender, mut output) = mpsc::channel(16);
    let response_visible = Arc::new(Notify::new());
    let release_response = Arc::new(Notify::new());
    let host = SdkHostConnection::with_output(
        runtime,
        "D:/workspace/project",
        Arc::new(BlockingSessionCreateOutput {
            output: sender,
            response_visible: response_visible.clone(),
            release_response: release_response.clone(),
        }),
        SdkHostConfig::default(),
        fake_installer(),
    );
    initialize(&host, &mut output).await;

    let create_host = host.clone();
    let create = tokio::spawn(async move {
        create_host
            .handle_request(request(serde_json::json!({
                "jsonrpc": "2.0",
                "id": "visible-create",
                "method": "session/create",
                "params": {}
            })))
            .await
    });
    response_visible.notified().await;
    let visible = output.recv().await.unwrap();
    assert_eq!(visible["id"], "visible-create");
    let session_id = visible["result"]["sessionId"].as_str().unwrap().to_string();

    let close_host = host.clone();
    let close = tokio::spawn(async move {
        close_host
            .handle_request(request(serde_json::json!({
                "jsonrpc": "2.0",
                "id": "close-before-create-delivery-commits",
                "method": "session/close",
                "params": { "sessionId": session_id }
            })))
            .await
    });
    assert!(
        tokio::time::timeout(Duration::from_millis(50), output.recv())
            .await
            .is_err(),
        "close must wait until response visibility is committed"
    );
    release_response.notify_one();

    assert_eq!(create.await.unwrap(), ConnectionControl::Continue);
    assert_eq!(close.await.unwrap(), ConnectionControl::Continue);
    let closed = output.recv().await.unwrap();
    assert_eq!(closed["result"]["unloaded"], true);
    assert_eq!(owner.unload_requests.lock().unwrap().len(), 1);
    assert!(owner.delete_requests.lock().unwrap().is_empty());

    host.shutdown_connection().await;
}

#[tokio::test]
async fn shutdown_waits_for_in_flight_session_creation_then_cleans_it() {
    let queue = Arc::new(EventQueue::new(EventQueueConfig::default()));
    let owner = Arc::new(FakeOwner::blocking_session_create(queue.clone()));
    let runtime = AgentRuntimeBuilder::new()
        .with_submission_port(owner.clone())
        .with_dialog_turn_port(owner.clone())
        .with_cancellation_port(owner.clone())
        .with_turn_settlement_port(owner.clone())
        .with_session_management_port(owner.clone())
        .with_session_close_port(owner.clone())
        .with_permission_request_manager(permission_manager())
        .with_event_source(AgentEventSource::new(queue))
        .build()
        .unwrap();
    let (sender, mut output) = mpsc::channel(16);
    let host = SdkHostConnection::new(
        runtime,
        "D:/workspace/project",
        sender,
        SdkHostConfig::default(),
        fake_installer(),
    );
    initialize(&host, &mut output).await;

    let create_host = host.clone();
    let create = tokio::spawn(async move {
        create_host
            .handle_request(request(serde_json::json!({
                "jsonrpc": "2.0",
                "id": "late-create",
                "method": "session/create",
                "params": {}
            })))
            .await
    });
    owner.session_create_started.notified().await;

    let shutdown_host = host.clone();
    let mut shutdown = tokio::spawn(async move { shutdown_host.shutdown_connection().await });
    assert!(
        tokio::time::timeout(Duration::from_millis(50), &mut shutdown)
            .await
            .is_err(),
        "shutdown must not abandon the Core Session creation transaction"
    );
    owner.release_session_create.notify_one();

    assert_eq!(create.await.unwrap(), ConnectionControl::Continue);
    shutdown.await.unwrap();
    let deleted = owner.delete_requests.lock().unwrap();
    assert_eq!(deleted.len(), 1);
    assert_eq!(deleted[0].session_id, owner.last_created_session_id());
}

#[tokio::test]
async fn shutdown_compensates_a_session_creation_task_that_panics_after_creation() {
    let queue = Arc::new(EventQueue::new(EventQueueConfig::default()));
    let owner = Arc::new(FakeOwner::panicking_session_create(queue.clone(), false));
    let runtime = AgentRuntimeBuilder::new()
        .with_submission_port(owner.clone())
        .with_dialog_turn_port(owner.clone())
        .with_cancellation_port(owner.clone())
        .with_turn_settlement_port(owner.clone())
        .with_session_management_port(owner.clone())
        .with_session_close_port(owner.clone())
        .with_permission_request_manager(permission_manager())
        .with_event_source(AgentEventSource::new(queue))
        .build()
        .unwrap();
    let (sender, mut output) = mpsc::channel(16);
    let host = SdkHostConnection::new(
        runtime,
        "D:/workspace/project",
        sender,
        SdkHostConfig::default(),
        fake_installer(),
    );
    initialize(&host, &mut output).await;

    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "panic-create",
        "method": "session/create",
        "params": {}
    })))
    .await;
    let _creation_failure = output.recv().await.unwrap();

    assert!(
        host.shutdown_connection_bounded(Duration::from_secs(1))
            .await
    );
    let deleted = owner.delete_requests.lock().unwrap();
    assert_eq!(deleted.len(), 1);
    assert_eq!(deleted[0].session_id, owner.last_created_session_id());
}

#[tokio::test]
async fn shutdown_reports_failure_when_post_panic_session_compensation_fails() {
    let queue = Arc::new(EventQueue::new(EventQueueConfig::default()));
    let owner = Arc::new(FakeOwner::panicking_session_create(queue.clone(), true));
    let runtime = AgentRuntimeBuilder::new()
        .with_submission_port(owner.clone())
        .with_dialog_turn_port(owner.clone())
        .with_cancellation_port(owner.clone())
        .with_turn_settlement_port(owner.clone())
        .with_session_management_port(owner.clone())
        .with_session_close_port(owner.clone())
        .with_permission_request_manager(permission_manager())
        .with_event_source(AgentEventSource::new(queue))
        .build()
        .unwrap();
    let (sender, mut output) = mpsc::channel(16);
    let host = SdkHostConnection::new(
        runtime,
        "D:/workspace/project",
        sender,
        SdkHostConfig::default(),
        fake_installer(),
    );
    initialize(&host, &mut output).await;

    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "panic-create-failed-cleanup",
        "method": "session/create",
        "params": {}
    })))
    .await;
    let _creation_failure = output.recv().await.unwrap();

    assert!(
        !host
            .shutdown_connection_bounded(Duration::from_secs(1))
            .await
    );
    assert_eq!(owner.delete_requests.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_later_request_registers_panicked_session_cleanup_for_shutdown() {
    let queue = Arc::new(EventQueue::new(EventQueueConfig::default()));
    let owner = Arc::new(FakeOwner::panicking_session_create(queue.clone(), false));
    let runtime = AgentRuntimeBuilder::new()
        .with_submission_port(owner.clone())
        .with_dialog_turn_port(owner.clone())
        .with_cancellation_port(owner.clone())
        .with_turn_settlement_port(owner.clone())
        .with_session_management_port(owner.clone())
        .with_session_close_port(owner.clone())
        .with_permission_request_manager(permission_manager())
        .with_event_source(AgentEventSource::new(queue))
        .build()
        .unwrap();
    let (sender, mut output) = mpsc::channel(16);
    let host = SdkHostConnection::new(
        runtime,
        "D:/workspace/project",
        sender,
        SdkHostConfig::default(),
        fake_installer(),
    );
    initialize(&host, &mut output).await;

    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "panic-create-before-reap",
        "method": "session/create",
        "params": {}
    })))
    .await;
    let _creation_failure = output.recv().await.unwrap();

    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "after-panic",
        "method": "session/close",
        "params": { "sessionId": "missing" }
    })))
    .await;
    let cleanup_required = output.recv().await.unwrap();
    assert_eq!(cleanup_required["id"], "after-panic");
    assert_eq!(
        cleanup_required["error"]["data"]["code"],
        "cleanup_required"
    );
    assert!(owner.delete_requests.lock().unwrap().is_empty());

    assert!(
        host.shutdown_connection_bounded(Duration::from_secs(1))
            .await
    );
    let deleted = owner.delete_requests.lock().unwrap();
    assert_eq!(deleted.len(), 1);
    assert_eq!(deleted[0].session_id, owner.last_created_session_id());
}

#[tokio::test]
async fn shutdown_does_not_forget_cleanup_registered_by_a_later_request() {
    let queue = Arc::new(EventQueue::new(EventQueueConfig::default()));
    let owner = Arc::new(FakeOwner::panicking_session_create(queue.clone(), true));
    let runtime = AgentRuntimeBuilder::new()
        .with_submission_port(owner.clone())
        .with_dialog_turn_port(owner.clone())
        .with_cancellation_port(owner.clone())
        .with_turn_settlement_port(owner.clone())
        .with_session_management_port(owner.clone())
        .with_session_close_port(owner.clone())
        .with_permission_request_manager(permission_manager())
        .with_event_source(AgentEventSource::new(queue))
        .build()
        .unwrap();
    let (sender, mut output) = mpsc::channel(16);
    let host = SdkHostConnection::new(
        runtime,
        "D:/workspace/project",
        sender,
        SdkHostConfig::default(),
        fake_installer(),
    );
    initialize(&host, &mut output).await;

    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "panic-create-before-failed-reap",
        "method": "session/create",
        "params": {}
    })))
    .await;
    let _creation_failure = output.recv().await.unwrap();

    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "after-panic-failed-reap",
        "method": "session/close",
        "params": { "sessionId": "missing" }
    })))
    .await;
    let cleanup_required = output.recv().await.unwrap();
    assert_eq!(
        cleanup_required["error"]["data"]["code"],
        "cleanup_required"
    );

    assert!(
        !host
            .shutdown_connection_bounded(Duration::from_secs(1))
            .await
    );
    let deleted = owner.delete_requests.lock().unwrap();
    assert_eq!(deleted.len(), 1);
    assert_eq!(deleted[0].session_id, owner.last_created_session_id());
}

#[tokio::test]
async fn existing_session_rejects_create_only_query_options() {
    let (host, _, mut output) = host().await;
    initialize(&host, &mut output).await;

    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "invalid-query-options",
        "method": "query/start",
        "params": {
            "prompt": "hello",
            "sessionId": "session-fixture",
            "model": "model-for-a-new-session"
        }
    })))
    .await;

    let error = output.recv().await.unwrap();
    assert_eq!(error["error"]["code"], -32602);
    assert_eq!(error["error"]["data"]["code"], "invalid_request");
}

#[tokio::test]
async fn existing_transient_session_cannot_be_adopted_as_durable() {
    let (host, _, mut output) = host().await;
    initialize(&host, &mut output).await;

    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "transient-adopt",
        "method": "query/start",
        "params": {
            "prompt": "do not adopt another connection's transient Session",
            "sessionId": "transient-fixture"
        }
    })))
    .await;

    let error = output.recv().await.unwrap();
    assert_eq!(error["id"], "transient-adopt");
    assert_eq!(error["error"]["data"]["code"], "capability_unavailable");
    assert!(error["error"]["message"]
        .as_str()
        .is_some_and(|message| message.contains("created or resumed")));
}

#[tokio::test]
async fn failed_implicit_query_submission_deletes_the_unexposed_session() {
    let queue = Arc::new(EventQueue::new(EventQueueConfig::default()));
    let owner = Arc::new(FakeOwner::failing_dialog(queue.clone()));
    let runtime = AgentRuntimeBuilder::new()
        .with_submission_port(owner.clone())
        .with_dialog_turn_port(owner.clone())
        .with_cancellation_port(owner.clone())
        .with_turn_settlement_port(owner.clone())
        .with_session_management_port(owner.clone())
        .with_session_close_port(owner.clone())
        .with_permission_request_manager(permission_manager())
        .with_event_source(AgentEventSource::new(queue))
        .build()
        .unwrap();
    let (sender, mut output) = mpsc::channel(16);
    let host = SdkHostConnection::new(
        runtime,
        "D:/workspace/project",
        sender,
        SdkHostConfig::default(),
        fake_installer(),
    );
    initialize(&host, &mut output).await;

    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "failed-query",
        "method": "query/start",
        "params": { "prompt": "hello" }
    })))
    .await;

    let error = output.recv().await.unwrap();
    assert_eq!(error["error"]["data"]["code"], "internal");
    let deleted = owner.discard_requests.lock().unwrap();
    assert_eq!(deleted.len(), 1);
    assert_eq!(deleted[0].session_id, owner.last_created_session_id());
}

#[tokio::test]
async fn shutdown_takes_over_failed_query_start_cleanup_within_its_total_budget() {
    let queue = Arc::new(EventQueue::new(EventQueueConfig::default()));
    let owner = Arc::new(FakeOwner::blocking_first_cancel(queue.clone()));
    let runtime = AgentRuntimeBuilder::new()
        .with_submission_port(owner.clone())
        .with_dialog_turn_port(owner.clone())
        .with_cancellation_port(owner.clone())
        .with_turn_settlement_port(owner.clone())
        .with_session_management_port(owner.clone())
        .with_session_close_port(owner.clone())
        .with_permission_request_manager(permission_manager())
        .with_event_source(AgentEventSource::new(queue))
        .build()
        .unwrap();
    let (sender, mut output) = mpsc::channel(16);
    let host = SdkHostConnection::with_output(
        runtime,
        "D:/workspace/project",
        Arc::new(FailQueryStartOutput { output: sender }),
        SdkHostConfig::default(),
        fake_installer(),
    );
    initialize(&host, &mut output).await;

    let query_host = host.clone();
    let query = tokio::spawn(async move {
        query_host
            .handle_request(request(serde_json::json!({
                "jsonrpc": "2.0",
                "id": "lost-query-start",
                "method": "query/start",
                "params": { "prompt": "hello" }
            })))
            .await
    });
    owner.first_cancel_started.notified().await;

    let shutdown =
        tokio::time::timeout(Duration::from_millis(500), host.shutdown_connection()).await;
    if shutdown.is_err() {
        owner.release_first_cancel.notify_waiters();
        host.shutdown_connection().await;
    }
    assert!(
        shutdown.is_ok(),
        "connection shutdown must take over a failed response's slower cleanup path"
    );
    assert_eq!(query.await.unwrap(), ConnectionControl::Continue);
    assert!(owner.cancel_requests.lock().unwrap().len() >= 2);
    assert_eq!(owner.discard_requests.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn failed_unexposed_session_cleanup_poison_connection_and_allows_shutdown() {
    let queue = Arc::new(EventQueue::new(EventQueueConfig::default()));
    let owner = Arc::new(FakeOwner::failing_dialog_and_delete(queue.clone()));
    let runtime = AgentRuntimeBuilder::new()
        .with_submission_port(owner.clone())
        .with_dialog_turn_port(owner.clone())
        .with_cancellation_port(owner.clone())
        .with_turn_settlement_port(owner.clone())
        .with_session_management_port(owner.clone())
        .with_session_close_port(owner.clone())
        .with_permission_request_manager(permission_manager())
        .with_event_source(AgentEventSource::new(queue))
        .build()
        .unwrap();
    let (sender, mut output) = mpsc::channel(16);
    let host = SdkHostConnection::new(
        runtime,
        "D:/workspace/project",
        sender,
        SdkHostConfig::default(),
        fake_installer(),
    );
    initialize(&host, &mut output).await;

    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "failed-query-cleanup",
        "method": "query/start",
        "params": { "prompt": "hello" }
    })))
    .await;
    let cleanup_error = output.recv().await.unwrap();
    assert_eq!(cleanup_error["error"]["data"]["code"], "cleanup_required");
    assert_eq!(cleanup_error["error"]["data"]["retryable"], false);
    assert_eq!(cleanup_error["error"]["data"]["recovery"], "restart_host");

    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "rejected-after-cleanup",
        "method": "session/create",
        "params": {}
    })))
    .await;
    assert_eq!(
        output.recv().await.unwrap()["error"]["data"]["code"],
        "cleanup_required"
    );

    assert_eq!(
        host.handle_request(request(serde_json::json!({
            "jsonrpc": "2.0",
            "id": "shutdown-after-cleanup",
            "method": "shutdown",
            "params": {}
        })))
        .await,
        ConnectionControl::Shutdown
    );
    assert_eq!(output.recv().await.unwrap()["result"]["accepted"], true);
}

#[tokio::test]
async fn terminal_failure_is_typed_and_emitted_after_settlement() {
    let (host, owner, mut output) = host_with_query_limit(1).await;
    initialize(&host, &mut output).await;
    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "query-failure",
        "method": "query/start",
        "params": { "prompt": "hello" }
    })))
    .await;
    let accepted = output.recv().await.unwrap();
    let query_id = accepted["result"]["queryId"].as_str().unwrap();
    let turn_id = accepted["result"]["turnId"].as_str().unwrap().to_string();
    let session_id = accepted["result"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();
    let queue = owner.queue.lock().unwrap().clone().unwrap();
    owner.set_settlement_status(AgentTurnSettlementStatus::Failed);
    queue
        .enqueue(
            AgenticEvent::DialogTurnFailed {
                session_id,
                turn_id,
                error: "provider unavailable".to_string(),
                error_category: Some(ErrorCategory::ProviderUnavailable),
                error_detail: None,
            },
            None,
        )
        .await
        .unwrap();

    let result = loop {
        let value = output.recv().await.unwrap();
        if value["method"] == "query/result" {
            break value;
        }
    };
    assert_eq!(result["params"]["queryId"], query_id);
    assert_eq!(result["params"]["status"], "failed");
    assert_eq!(
        result["params"]["error"]["data"]["code"],
        "provider_unavailable"
    );
    assert_eq!(result["params"]["error"]["data"]["retryable"], true);
    assert_eq!(owner.settlement_requests.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn uncertain_turn_settlement_fails_the_connection_without_a_result() {
    let queue = Arc::new(EventQueue::new(EventQueueConfig::default()));
    let owner = Arc::new(FakeOwner::failing_settlement(queue.clone()));
    let runtime = AgentRuntimeBuilder::new()
        .with_submission_port(owner.clone())
        .with_dialog_turn_port(owner.clone())
        .with_cancellation_port(owner.clone())
        .with_turn_settlement_port(owner.clone())
        .with_session_management_port(owner.clone())
        .with_session_close_port(owner.clone())
        .with_permission_request_manager(permission_manager())
        .with_event_source(AgentEventSource::new(queue))
        .build()
        .unwrap();
    let (sender, mut output) = mpsc::channel(16);
    let host = SdkHostConnection::new(
        runtime,
        "D:/workspace/project",
        sender,
        SdkHostConfig::default(),
        fake_installer(),
    );
    let connection_failed = host.connection_failed_token();
    initialize(&host, &mut output).await;
    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "uncertain-query",
        "method": "query/start",
        "params": { "prompt": "hello" }
    })))
    .await;
    let accepted = output.recv().await.unwrap();
    let session_id = accepted["result"]["sessionId"].as_str().unwrap();
    timeout(Duration::from_secs(1), connection_failed.cancelled())
        .await
        .expect("uncertain Turn settlement must fail the connection");
    while let Ok(Some(value)) = timeout(Duration::from_millis(50), output.recv()).await {
        assert_ne!(value["method"], "query/result");
    }

    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "retry-uncertain-session",
        "method": "query/start",
        "params": { "prompt": "do not duplicate", "sessionId": session_id }
    })))
    .await;
    let retry = output.recv().await.unwrap();
    assert_eq!(retry["error"]["data"]["code"], "cleanup_required");
    assert_eq!(owner.dialog_metadata.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn query_submission_disables_unavailable_interactive_callbacks() {
    let (host, owner, mut output) = host_with_query_limit(1).await;
    initialize(&host, &mut output).await;
    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "noninteractive-query",
        "method": "query/start",
        "params": { "prompt": "hello" }
    })))
    .await;
    assert_eq!(output.recv().await.unwrap()["result"]["accepted"], true);

    // Scoped so the guard is provably released before the await below.
    {
        let metadata = owner.dialog_metadata.lock().unwrap();
        assert_eq!(metadata.len(), 1);
        assert_eq!(metadata[0]["user_input_available"], false);
        assert_eq!(metadata[0]["auto_approve_ask"], false);
    }
    host.shutdown_connection().await;
}

#[tokio::test]
async fn provider_quota_and_billing_keep_distinct_wire_codes() {
    for (category, expected_code) in [
        (ErrorCategory::ProviderQuota, "provider_quota"),
        (ErrorCategory::ProviderBilling, "provider_billing"),
    ] {
        let (host, owner, mut output) = host_with_query_limit(1).await;
        initialize(&host, &mut output).await;
        host.handle_request(request(serde_json::json!({
            "jsonrpc": "2.0",
            "id": expected_code,
            "method": "query/start",
            "params": { "prompt": "hello" }
        })))
        .await;
        let accepted = output.recv().await.unwrap();
        let turn_id = accepted["result"]["turnId"].as_str().unwrap().to_string();
        let session_id = accepted["result"]["sessionId"]
            .as_str()
            .unwrap()
            .to_string();
        // Cloned out of the guard first: the guard must not survive the
        // `enqueue` await below.
        let queue = owner.queue.lock().unwrap().clone().unwrap();
        owner.set_settlement_status(AgentTurnSettlementStatus::Failed);
        queue
            .enqueue(
                AgenticEvent::DialogTurnFailed {
                    session_id,
                    turn_id,
                    error: format!("{expected_code} fixture"),
                    error_category: Some(category),
                    error_detail: None,
                },
                None,
            )
            .await
            .unwrap();

        let result = loop {
            let value = output.recv().await.unwrap();
            if value["method"] == "query/result" {
                break value;
            }
        };
        assert_eq!(result["params"]["error"]["data"]["code"], expected_code);
        assert_eq!(result["params"]["error"]["data"]["retryable"], false);
    }
}

#[tokio::test]
async fn queued_query_is_accepted_and_tracked_by_its_exact_turn() {
    let queue = Arc::new(EventQueue::new(EventQueueConfig::default()));
    let owner = Arc::new(FakeOwner::queued_dialog(queue.clone()));
    let runtime = AgentRuntimeBuilder::new()
        .with_submission_port(owner.clone())
        .with_dialog_turn_port(owner.clone())
        .with_cancellation_port(owner.clone())
        .with_turn_settlement_port(owner.clone())
        .with_session_management_port(owner.clone())
        .with_session_close_port(owner.clone())
        .with_permission_request_manager(permission_manager())
        .with_event_source(AgentEventSource::new(queue))
        .build()
        .unwrap();
    let (sender, mut output) = mpsc::channel(16);
    let host = SdkHostConnection::new(
        runtime,
        "D:/workspace/project",
        sender,
        SdkHostConfig::default(),
        fake_installer(),
    );
    initialize(&host, &mut output).await;

    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "create-for-queued-query",
        "method": "session/create",
        "params": {}
    })))
    .await;
    let created = output.recv().await.unwrap();
    assert_eq!(created["result"]["lifetime"], "durable");
    let session_id = created["result"]["sessionId"]
        .as_str()
        .expect("created Session id")
        .to_string();

    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "queued-query",
        "method": "query/start",
        "params": {
            "prompt": "hello",
            "sessionId": session_id
        }
    })))
    .await;

    let accepted = output.recv().await.unwrap();
    assert_eq!(accepted["result"]["accepted"], true);
    assert_eq!(accepted["result"]["turnId"], "turn-fixture");
    assert!(owner.cancel_requests.lock().unwrap().is_empty());

    let queue = owner.queue.lock().unwrap().clone().unwrap();
    queue
        .enqueue(
            AgenticEvent::DialogTurnCompleted {
                session_id: session_id.clone(),
                turn_id: "another-surface-turn".to_string(),
                total_rounds: 1,
                total_tools: 0,
                duration_ms: 1,
                partial_recovery_reason: None,
                success: Some(true),
                finish_reason: Some("stop".to_string()),
                has_final_response: Some(true),
            },
            None,
        )
        .await
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(50), output.recv())
            .await
            .is_err()
    );
    queue
        .enqueue(
            AgenticEvent::DialogTurnCompleted {
                session_id,
                turn_id: "turn-fixture".to_string(),
                total_rounds: 1,
                total_tools: 0,
                duration_ms: 1,
                partial_recovery_reason: None,
                success: Some(true),
                finish_reason: Some("stop".to_string()),
                has_final_response: Some(true),
            },
            None,
        )
        .await
        .unwrap();
    let result = output.recv().await.unwrap();
    assert_eq!(result["method"], "query/result");
    assert_eq!(result["params"]["turnId"], "turn-fixture");
}

#[tokio::test]
async fn session_close_rejects_while_query_start_is_in_flight() {
    let queue = Arc::new(EventQueue::new(EventQueueConfig::default()));
    let owner = Arc::new(FakeOwner::blocking_dialog(queue.clone()));
    let runtime = AgentRuntimeBuilder::new()
        .with_submission_port(owner.clone())
        .with_dialog_turn_port(owner.clone())
        .with_cancellation_port(owner.clone())
        .with_turn_settlement_port(owner.clone())
        .with_session_management_port(owner.clone())
        .with_session_close_port(owner.clone())
        .with_permission_request_manager(permission_manager())
        .with_event_source(AgentEventSource::new(queue))
        .build()
        .unwrap();
    let (sender, mut output) = mpsc::channel(16);
    let host = SdkHostConnection::new(
        runtime,
        "D:/workspace/project",
        sender,
        SdkHostConfig::default(),
        fake_installer(),
    );
    initialize(&host, &mut output).await;
    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "create-session",
        "method": "session/create",
        "params": {}
    })))
    .await;
    let created = output.recv().await.unwrap();
    assert_eq!(created["id"], "create-session");
    let session_id = created["result"]["sessionId"].as_str().unwrap().to_string();

    let query_host = host.clone();
    let query_session_id = session_id.clone();
    let query = tokio::spawn(async move {
        query_host
            .handle_request(request(serde_json::json!({
                "jsonrpc": "2.0",
                "id": "slow-query-start",
                "method": "query/start",
                "params": {
                    "prompt": "hello",
                    "sessionId": query_session_id
                }
            })))
            .await
    });
    owner.dialog_submit_started.notified().await;

    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "racing-close",
        "method": "session/close",
        "params": { "sessionId": session_id }
    })))
    .await;
    let close_error = output.recv().await.unwrap();
    assert_eq!(close_error["id"], "racing-close");
    assert_eq!(close_error["error"]["data"]["code"], "overloaded");
    owner.release_dialog_submit.notify_one();
    assert_eq!(query.await.unwrap(), ConnectionControl::Continue);
    let started = output.recv().await.unwrap();
    assert_eq!(started["id"], "slow-query-start");
    assert_eq!(started["result"]["accepted"], true);
    host.shutdown_connection().await;
}

#[tokio::test]
async fn query_start_rejects_if_session_close_finishes_before_reservation() {
    let queue = Arc::new(EventQueue::new(EventQueueConfig::default()));
    let owner = Arc::new(FakeOwner::blocking_agent_resolution(queue.clone()));
    let runtime = AgentRuntimeBuilder::new()
        .with_submission_port(owner.clone())
        .with_dialog_turn_port(owner.clone())
        .with_cancellation_port(owner.clone())
        .with_turn_settlement_port(owner.clone())
        .with_session_management_port(owner.clone())
        .with_session_close_port(owner.clone())
        .with_permission_request_manager(permission_manager())
        .with_event_source(AgentEventSource::new(queue))
        .build()
        .unwrap();
    let (sender, mut output) = mpsc::channel(16);
    let host = SdkHostConnection::new(
        runtime,
        "D:/workspace/project",
        sender,
        SdkHostConfig::default(),
        fake_installer(),
    );
    initialize(&host, &mut output).await;
    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "create-session",
        "method": "session/create",
        "params": {}
    })))
    .await;
    let created = output.recv().await.unwrap();
    assert_eq!(created["id"], "create-session");
    let session_id = created["result"]["sessionId"].as_str().unwrap().to_string();

    let query_host = host.clone();
    let query_session_id = session_id.clone();
    let query = tokio::spawn(async move {
        query_host
            .handle_request(request(serde_json::json!({
                "jsonrpc": "2.0",
                "id": "query-after-close",
                "method": "query/start",
                "params": {
                    "prompt": "hello",
                    "sessionId": query_session_id
                }
            })))
            .await
    });
    owner.agent_resolution_started.notified().await;

    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "close-before-reserve",
        "method": "session/close",
        "params": { "sessionId": session_id }
    })))
    .await;
    let closed = output.recv().await.unwrap();
    assert_eq!(closed["id"], "close-before-reserve");
    assert_eq!(closed["result"]["unloaded"], true);

    owner.release_agent_resolution.notify_one();
    assert_eq!(query.await.unwrap(), ConnectionControl::Continue);
    let rejected = output.recv().await.unwrap();
    assert_eq!(rejected["id"], "query-after-close");
    assert_eq!(rejected["error"]["data"]["code"], "overloaded");
}

#[tokio::test]
async fn permission_request_is_streamed_and_can_be_allowed_once() {
    let queue = Arc::new(EventQueue::new(EventQueueConfig::default()));
    let owner = Arc::new(FakeOwner::without_terminal(queue.clone()));
    let permissions = permission_manager();
    let runtime = AgentRuntimeBuilder::new()
        .with_submission_port(owner.clone())
        .with_dialog_turn_port(owner.clone())
        .with_cancellation_port(owner.clone())
        .with_turn_settlement_port(owner.clone())
        .with_session_management_port(owner.clone())
        .with_session_close_port(owner.clone())
        .with_permission_request_manager(permissions.clone())
        .with_event_source(AgentEventSource::new(queue))
        .build()
        .unwrap();
    let (sender, mut output) = mpsc::channel(16);
    let host = SdkHostConnection::new(
        runtime,
        "D:/workspace/project",
        sender,
        SdkHostConfig {
            permission_response_timeout: Duration::from_millis(250),
            ..SdkHostConfig::default()
        },
        fake_installer(),
    );
    initialize(&host, &mut output).await;
    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "query-permission",
        "method": "query/start",
        "params": { "prompt": "edit a file" }
    })))
    .await;
    let accepted = output.recv().await.unwrap();
    assert_eq!(accepted["result"]["accepted"], true);
    let session_id = accepted["result"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(output.recv().await.unwrap()["method"], "query/event");

    let permission_request = permission_request_fixture("permission-fixture", 0, &session_id);
    let unrelated = permissions
        .register_batch_for_turn(
            vec![PermissionRequest {
                request_id: "permission-other-turn".to_string(),
                ..permission_request.clone()
            }],
            "another-turn",
        )
        .await
        .unwrap()
        .pop()
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(50), output.recv())
            .await
            .is_err()
    );
    permissions
        .cancel_request("permission-other-turn", "test cleanup")
        .await
        .unwrap();
    assert!(matches!(
        unrelated.wait().await,
        openbitfun_agent_runtime::permission::PermissionWaitOutcome::Cancelled { .. }
    ));

    let pending = permissions
        .register_batch_for_turn(vec![permission_request.clone()], "turn-fixture")
        .await
        .unwrap()
        .pop()
        .unwrap();

    let permission = output.recv().await.unwrap();
    assert_eq!(permission["method"], "query/event");
    assert_eq!(permission["params"]["event"]["type"], "permission_request");
    assert_eq!(
        permission["params"]["event"]["requestId"],
        "permission-fixture"
    );
    assert_eq!(permission["params"]["event"]["action"], "edit");
    assert_eq!(
        permission["params"]["event"]["resources"],
        serde_json::json!(["src/lib.rs"])
    );
    assert_eq!(permission["params"]["event"]["source"]["kind"], "tool_call");

    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "permission-response",
        "method": "permission/respond",
        "params": {
            "queryId": accepted["result"]["queryId"],
            "sessionId": accepted["result"]["sessionId"],
            "turnId": accepted["result"]["turnId"],
            "operationId": accepted["result"]["operationId"],
            "requestId": "permission-fixture",
            "decision": "allow_once"
        }
    })))
    .await;
    let response = output.recv().await.unwrap();
    assert_eq!(response["result"]["accepted"], true);
    assert_eq!(response["result"]["requestId"], "permission-fixture");

    let resolution = pending.wait().await;
    assert!(matches!(
        resolution,
        openbitfun_agent_runtime::permission::PermissionWaitOutcome::Replied(
            openbitfun_agent_runtime::sdk::PermissionReply::Once
        )
    ));

    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "duplicate-permission-response",
        "method": "permission/respond",
        "params": {
            "queryId": accepted["result"]["queryId"],
            "sessionId": accepted["result"]["sessionId"],
            "turnId": accepted["result"]["turnId"],
            "operationId": accepted["result"]["operationId"],
            "requestId": "permission-fixture",
            "decision": "allow_once"
        }
    })))
    .await;
    assert_eq!(
        output.recv().await.unwrap()["error"]["data"]["code"],
        "not_found"
    );

    let rejected = permissions
        .register_batch_for_turn(
            vec![permission_request_fixture(
                "permission-rejected",
                1,
                accepted["result"]["sessionId"].as_str().unwrap(),
            )],
            "turn-fixture",
        )
        .await
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(
        output.recv().await.unwrap()["params"]["event"]["requestId"],
        "permission-rejected"
    );

    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "wrong-query-identity",
        "method": "permission/respond",
        "params": {
            "queryId": accepted["result"]["queryId"],
            "sessionId": accepted["result"]["sessionId"],
            "turnId": accepted["result"]["turnId"],
            "operationId": "another-operation",
            "requestId": "permission-rejected",
            "decision": "reject",
            "feedback": "not needed"
        }
    })))
    .await;
    assert_eq!(
        output.recv().await.unwrap()["error"]["data"]["code"],
        "invalid_request"
    );

    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "reject-permission",
        "method": "permission/respond",
        "params": {
            "queryId": accepted["result"]["queryId"],
            "sessionId": accepted["result"]["sessionId"],
            "turnId": accepted["result"]["turnId"],
            "operationId": accepted["result"]["operationId"],
            "requestId": "permission-rejected",
            "decision": "reject",
            "feedback": "not needed"
        }
    })))
    .await;
    assert_eq!(output.recv().await.unwrap()["result"]["accepted"], true);
    assert!(matches!(
        rejected.wait().await,
        openbitfun_agent_runtime::permission::PermissionWaitOutcome::Replied(
            openbitfun_agent_runtime::sdk::PermissionReply::Reject { feedback }
        ) if feedback.as_deref() == Some("not needed")
    ));

    let expired = permissions
        .register_batch_for_turn(
            vec![permission_request_fixture(
                "permission-expired",
                2,
                accepted["result"]["sessionId"].as_str().unwrap(),
            )],
            "turn-fixture",
        )
        .await
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(
        output.recv().await.unwrap()["params"]["event"]["requestId"],
        "permission-expired"
    );
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(1), expired.wait())
            .await
            .expect("permission timeout must settle through the Runtime owner"),
        openbitfun_agent_runtime::permission::PermissionWaitOutcome::Replied(
            openbitfun_agent_runtime::sdk::PermissionReply::Reject { feedback }
        ) if feedback.as_deref() == Some("SDK permission response timed out")
    ));

    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "cancel-after-permission",
        "method": "query/cancel",
        "params": {
            "queryId": accepted["result"]["queryId"],
            "sessionId": accepted["result"]["sessionId"],
            "turnId": accepted["result"]["turnId"],
            "operationId": accepted["result"]["operationId"]
        }
    })))
    .await;
}

#[tokio::test]
async fn stalled_user_permission_response_is_bounded_and_cancels_the_exact_turn() {
    let queue = Arc::new(EventQueue::new(EventQueueConfig::default()));
    let owner = Arc::new(FakeOwner::without_terminal(queue.clone()));
    let permissions = blocking_permission_manager();
    let runtime = AgentRuntimeBuilder::new()
        .with_submission_port(owner.clone())
        .with_dialog_turn_port(owner.clone())
        .with_cancellation_port(owner.clone())
        .with_turn_settlement_port(owner.clone())
        .with_session_management_port(owner.clone())
        .with_session_close_port(owner.clone())
        .with_permission_request_manager(permissions.clone())
        .with_event_source(AgentEventSource::new(queue))
        .build()
        .unwrap();
    let (sender, mut output) = mpsc::channel(16);
    let host = SdkHostConnection::new(
        runtime,
        "D:/workspace/project",
        sender,
        SdkHostConfig::default(),
        fake_installer(),
    );
    initialize(&host, &mut output).await;
    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "query-stalled-permission",
        "method": "query/start",
        "params": { "prompt": "edit a file" }
    })))
    .await;
    let accepted = output.recv().await.unwrap();
    assert_eq!(accepted["result"]["accepted"], true);
    let session_id = accepted["result"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(output.recv().await.unwrap()["method"], "query/event");

    let _pending = permissions
        .register_batch_for_turn(
            vec![permission_request_fixture(
                "permission-stalled",
                0,
                &session_id,
            )],
            "turn-fixture",
        )
        .await
        .unwrap()
        .pop()
        .unwrap();

    let permission = output.recv().await.unwrap();
    assert_eq!(
        permission["params"]["event"]["requestId"],
        "permission-stalled"
    );
    host.handle_request(request(serde_json::json!({
        "jsonrpc": "2.0",
        "id": "stalled-permission-response",
        "method": "permission/respond",
        "params": {
            "queryId": accepted["result"]["queryId"],
            "sessionId": accepted["result"]["sessionId"],
            "turnId": accepted["result"]["turnId"],
            "operationId": accepted["result"]["operationId"],
            "requestId": "permission-stalled",
            "decision": "allow_once"
        }
    })))
    .await;

    let (result, response) = tokio::time::timeout(Duration::from_secs(5), async {
        let mut result = None;
        let mut response = None;
        loop {
            let value = output.recv().await.unwrap();
            if value["method"] == "query/result" {
                result = Some(value);
            } else if value["id"] == "stalled-permission-response" {
                response = Some(value);
            }
            if result.is_some() && response.is_some() {
                break (result.unwrap(), response.unwrap());
            }
        }
    })
    .await
    .expect("permission rejection must remain bounded");
    assert_eq!(result["params"]["error"]["data"]["code"], "timeout");
    assert_eq!(response["error"]["data"]["code"], "timeout");
    assert_eq!(response["error"]["data"]["retryable"], false);
    assert_eq!(
        owner.cancel_requests.lock().unwrap()[0].turn_id.as_deref(),
        Some("turn-fixture")
    );
}
