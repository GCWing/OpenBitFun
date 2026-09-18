//! Connection-scoped SDK Host request and Query lifecycle.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use futures_util::{stream::FuturesUnordered, FutureExt, StreamExt};
use openbitfun_agent_runtime::sdk::{
    AgentDialogTurnRequest, AgentInputAttachment, AgentRuntime, AgentSessionCreateRequest,
    AgentSessionCreateResult, AgentSessionDeleteRequest, AgentSessionModelUpdateRequest,
    AgentSessionReleaseRequest, AgentSessionRestoreRequest, AgentSessionWorkspaceRequest,
    AgentSubmissionSource, AgentTurnCancellationRequest, AgentTurnSettlementRequest,
    AgentTurnSettlementResult, AgentTurnSettlementStatus, DialogSubmissionPolicy,
    DialogSubmitOutcome, PermissionReply, PermissionReplySource, PermissionRequest,
    PermissionRequestEvent, PermissionRequestSourceKind, PortError, PortErrorKind, RuntimeError,
    TurnTokenUsage, AUTO_APPROVE_ASK_CONTEXT_KEY,
};
use openbitfun_agent_runtime::user_questions::USER_INPUT_AVAILABLE_CONTEXT_KEY;
use openbitfun_core_types::ErrorCategory;
use openbitfun_events::{AgenticEvent, ToolEventData};
use tokio::sync::{mpsc, oneshot, Mutex, OwnedSemaphorePermit, Semaphore};
use tokio::task::JoinHandle;
use tokio::time::{timeout, Instant};
use tokio_util::sync::CancellationToken;

use crate::protocol::{
    ErrorCode, ErrorData, ErrorStage, InitializeParams, InitializeResult, JsonRpcErrorResponse,
    JsonRpcNotification, JsonRpcRequest, JsonRpcSuccessResponse, OutcomeCertainty,
    PermissionDecision, PermissionRespondParams, PermissionRespondResult, PermissionSource,
    PermissionSourceKind, QueryCancelParams, QueryCancelResult, QueryEvent, QueryEventParams,
    QueryOutput, QueryResultError, QueryResultParams, QueryStartParams, QueryStartResult,
    QueryTerminalStatus, QueryUsage, RecoveryAction, RequestId, SessionCloseParams,
    SessionCloseResult, SessionCreateParams, SessionCreateResult, SessionLifetime,
    SessionResumeParams, ShutdownParams, ShutdownResult, TemporaryModelConfig, ToolEventStatus,
    JSON_RPC_VERSION, METHOD_INITIALIZE, METHOD_PERMISSION_RESPOND, METHOD_QUERY_CANCEL,
    METHOD_QUERY_START, METHOD_SESSION_CLOSE, METHOD_SESSION_CREATE, METHOD_SESSION_RESUME,
    METHOD_SHUTDOWN, NOTIFICATION_QUERY_EVENT, NOTIFICATION_QUERY_RESULT, PROTOCOL_VERSION,
};

const DEFAULT_SESSION_NAME: &str = "OpenBitFun SDK query";
const DEFAULT_AGENT: &str = "Standard";
const DEFAULT_TURN_SETTLEMENT_TIMEOUT_MS: u64 = 5_000;
const PERMISSION_REJECTION_TIMEOUT_MS: u64 = 2_000;
const DEFAULT_PERMISSION_RESPONSE_TIMEOUT_MS: u64 = 120_000;
const MAX_PERMISSION_FEEDBACK_BYTES: usize = 4 * 1024;
const MAX_SESSION_CLOSE_TIMEOUT_MS: u64 = 30_000;
const MAX_SESSION_PUBLICATION_WAIT_MS: u64 = 500;
const MAX_QUERY_OUTPUT_WIRE_BYTES: usize = 768 * 1024;

fn json_string_content_bytes(value: &str) -> usize {
    serde_json::to_vec(value)
        .expect("serializing a Rust string as JSON cannot fail")
        .len()
        .saturating_sub(2)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionControl {
    Continue,
    Shutdown,
}

#[derive(Debug, Clone)]
pub struct SdkHostConfig {
    pub max_in_flight_requests: usize,
    pub max_in_flight_control_requests: usize,
    pub max_active_queries: usize,
    pub max_leased_sessions: usize,
    pub permission_response_timeout: Duration,
}

impl Default for SdkHostConfig {
    fn default() -> Self {
        Self {
            max_in_flight_requests: 32,
            max_in_flight_control_requests: 4,
            max_active_queries: 16,
            max_leased_sessions: 64,
            permission_response_timeout: Duration::from_millis(
                DEFAULT_PERMISSION_RESPONSE_TIMEOUT_MS,
            ),
        }
    }
}

#[derive(Clone)]
pub struct SdkHostConnection {
    inner: Arc<ConnectionInner>,
}

#[async_trait::async_trait]
pub trait HostOutput: Send + Sync {
    async fn send(&self, value: serde_json::Value) -> Result<(), ()>;
}

#[async_trait::async_trait]
pub trait TemporaryModelInstaller: Send + Sync {
    async fn install(
        &self,
        model: TemporaryModelConfig,
    ) -> Result<String, TemporaryModelInstallError>;
    async fn remove(&self, model_id: &str);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TemporaryModelInstallError {
    InvalidModel,
    InvalidBaseUrl,
    Internal,
}

struct ChannelHostOutput(mpsc::Sender<serde_json::Value>);

#[async_trait::async_trait]
impl HostOutput for ChannelHostOutput {
    async fn send(&self, value: serde_json::Value) -> Result<(), ()> {
        self.0.send(value).await.map_err(|_| ())
    }
}

struct ConnectionInner {
    runtime: AgentRuntime,
    runtime_version: &'static str,
    default_cwd: String,
    output: Arc<dyn HostOutput>,
    temporary_model_installer: Arc<dyn TemporaryModelInstaller>,
    state: Arc<Mutex<ConnectionState>>,
    request_budget: Arc<Semaphore>,
    control_request_budget: Arc<Semaphore>,
    query_budget: Arc<Semaphore>,
    session_budget: Arc<Semaphore>,
    permission_response_timeout: Duration,
    shutdown_started: CancellationToken,
    connection_failed: CancellationToken,
}

#[derive(Default)]
struct ConnectionState {
    initialization: InitializationState,
    model_id: Option<String>,
    permission_responses: bool,
    shutting_down: bool,
    cleanup_failed: bool,
    sessions: HashMap<String, SessionLease>,
    queries: HashMap<String, Arc<QueryLease>>,
    attaching_sessions: HashSet<String>,
    publishing_sessions: HashSet<String>,
    starting_query_sessions: HashSet<String>,
    active_query_sessions: HashSet<String>,
    closing_sessions: HashSet<String>,
    poisoned_sessions: HashSet<String>,
    pending_session_tasks: Vec<PendingSessionTask>,
    untracked_session_cleanups: HashMap<String, SessionCleanup>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
enum InitializationState {
    #[default]
    Uninitialized,
    Installing,
    Initialized,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum QueryReservationError {
    Unavailable,
    Poisoned,
}

#[derive(Clone)]
struct SessionLease {
    /// Owning workspace record ID as reported by the runtime. Authoritative for
    /// every later runtime call; `workspace_path` stays the cwd operand.
    workspace_id: Option<String>,
    workspace_path: String,
    remote_connection_id: Option<String>,
    remote_ssh_host: Option<String>,
    exposed: bool,
    lifetime: SessionLifetime,
    unexposed_release: SessionReleaseKind,
    _budget: Arc<OwnedSemaphorePermit>,
}

struct PendingSessionTask {
    session_cleanup: Option<SessionCleanup>,
    reservation: Option<SessionTaskReservation>,
    task: JoinHandle<()>,
}

enum SessionTaskReservation {
    Attaching(String),
    Publishing(String),
}

fn release_session_task_reservation(
    state: &mut ConnectionState,
    reservation: &SessionTaskReservation,
) {
    match reservation {
        SessionTaskReservation::Attaching(session_id) => {
            state.attaching_sessions.remove(session_id);
        }
        SessionTaskReservation::Publishing(session_id) => {
            state.publishing_sessions.remove(session_id);
        }
    }
}

#[derive(Clone)]
struct SessionCleanup {
    session_id: String,
    /// Known once the runtime has reported the owning workspace record.
    workspace_id: Option<String>,
    workspace_path: String,
    release_kind: SessionReleaseKind,
}

#[derive(Clone, Copy)]
enum SessionReleaseKind {
    DiscardTransient,
    UnloadPersisted,
    DeletePersisted,
}

impl SessionLease {
    fn release_kind(&self) -> SessionReleaseKind {
        if !self.exposed {
            return self.unexposed_release;
        }
        match self.lifetime {
            SessionLifetime::Connection => SessionReleaseKind::DiscardTransient,
            SessionLifetime::Durable => SessionReleaseKind::UnloadPersisted,
        }
    }
}

struct QueryLease {
    query_id: String,
    session_id: String,
    turn_id: String,
    operation_id: String,
    event_budget: StdMutex<QueryEventBudget>,
    structured_output_requested: bool,
    usage: StdMutex<Option<TurnTokenUsage>>,
    terminal: AtomicBool,
    stop_forwarding: CancellationToken,
    emit_output: bool,
    pending_permissions: StdMutex<HashMap<String, CancellationToken>>,
    _budget: OwnedSemaphorePermit,
}

#[derive(Default)]
struct QueryEventBudget {
    wire_bytes: usize,
    structured_attempt: Option<QueryOutputAttempt>,
}

#[derive(Clone, PartialEq, Eq)]
struct QueryOutputAttempt {
    round_id: String,
    attempt_id: Option<String>,
    attempt_index: Option<u32>,
}

impl QueryEventBudget {
    fn observe(&mut self, text: &str, structured_attempt: Option<QueryOutputAttempt>) -> bool {
        if let Some(attempt) = structured_attempt {
            if self.structured_attempt.as_ref() != Some(&attempt) {
                self.wire_bytes = 0;
                self.structured_attempt = Some(attempt);
            }
        }

        let encoded_bytes = json_string_content_bytes(text);
        if encoded_bytes > MAX_QUERY_OUTPUT_WIRE_BYTES.saturating_sub(self.wire_bytes) {
            return false;
        }
        self.wire_bytes += encoded_bytes;
        true
    }
}

impl QueryLease {
    fn finish_once(&self) -> bool {
        !self.terminal.swap(true, Ordering::AcqRel)
    }
}

impl SdkHostConnection {
    pub fn new(
        runtime: AgentRuntime,
        default_cwd: impl Into<String>,
        output: mpsc::Sender<serde_json::Value>,
        config: SdkHostConfig,
        temporary_model_installer: Arc<dyn TemporaryModelInstaller>,
    ) -> Self {
        Self::with_output(
            runtime,
            default_cwd,
            Arc::new(ChannelHostOutput(output)),
            config,
            temporary_model_installer,
        )
    }

    pub fn with_output(
        runtime: AgentRuntime,
        default_cwd: impl Into<String>,
        output: Arc<dyn HostOutput>,
        config: SdkHostConfig,
        temporary_model_installer: Arc<dyn TemporaryModelInstaller>,
    ) -> Self {
        Self {
            inner: Arc::new(ConnectionInner {
                runtime,
                runtime_version: env!("CARGO_PKG_VERSION"),
                default_cwd: default_cwd.into(),
                output,
                temporary_model_installer,
                state: Arc::new(Mutex::new(ConnectionState::default())),
                request_budget: Arc::new(Semaphore::new(config.max_in_flight_requests.max(1))),
                control_request_budget: Arc::new(Semaphore::new(
                    config.max_in_flight_control_requests.max(1),
                )),
                query_budget: Arc::new(Semaphore::new(config.max_active_queries.max(1))),
                session_budget: Arc::new(Semaphore::new(config.max_leased_sessions.max(1))),
                permission_response_timeout: config.permission_response_timeout,
                shutdown_started: CancellationToken::new(),
                connection_failed: CancellationToken::new(),
            }),
        }
    }

    pub fn connection_failed_token(&self) -> CancellationToken {
        self.inner.connection_failed.clone()
    }

    pub async fn handle_request(&self, request: JsonRpcRequest) -> ConnectionControl {
        let request_id = request.id.clone();
        if request.jsonrpc != JSON_RPC_VERSION {
            self.send_rpc_error(
                request_id,
                -32600,
                ErrorCode::InvalidRequest,
                ErrorStage::Protocol,
                false,
                None,
                OutcomeCertainty::NotStarted,
                None,
                "jsonrpc must be 2.0",
            )
            .await;
            return ConnectionControl::Continue;
        }

        // Resource and request lifecycle methods require an addressable
        // response. Executing them as notifications would create Sessions or
        // Queries that the caller can neither identify nor close. Shutdown is
        // the only fire-and-forget client method in this protocol version.
        if request.id.is_none() && request.method != METHOD_SHUTDOWN {
            return ConnectionControl::Continue;
        }

        if request.method != METHOD_SHUTDOWN {
            self.reap_finished_pending_session_tasks().await;
        }

        let _request_permit = if request.method == METHOD_SHUTDOWN {
            None
        } else {
            let budget = if matches!(
                request.method.as_str(),
                METHOD_QUERY_CANCEL | METHOD_PERMISSION_RESPOND | METHOD_SESSION_CLOSE
            ) {
                self.inner.control_request_budget.clone()
            } else {
                self.inner.request_budget.clone()
            };
            let Ok(permit) = budget.try_acquire_owned() else {
                self.send_error(
                    request_id,
                    ErrorCode::Overloaded,
                    ErrorStage::Protocol,
                    true,
                    Some(RecoveryAction::Retry),
                    "SDK Host request capacity is exhausted",
                )
                .await;
                return ConnectionControl::Continue;
            };
            Some(permit)
        };

        if request.method == METHOD_INITIALIZE {
            self.handle_initialize(request).await;
            return ConnectionControl::Continue;
        }

        let (initialized, shutting_down, cleanup_failed) = {
            let state = self.inner.state.lock().await;
            (
                state.initialization == InitializationState::Initialized,
                state.shutting_down,
                state.cleanup_failed || !state.untracked_session_cleanups.is_empty(),
            )
        };
        if !initialized {
            self.send_error(
                request_id,
                ErrorCode::NotInitialized,
                ErrorStage::Protocol,
                true,
                Some(RecoveryAction::Initialize),
                "initialize must complete before this method",
            )
            .await;
            return ConnectionControl::Continue;
        }
        if cleanup_failed && request.method != METHOD_SHUTDOWN {
            self.send_error(
                request_id,
                ErrorCode::CleanupRequired,
                ErrorStage::Protocol,
                false,
                Some(RecoveryAction::RestartHost),
                "SDK Host cleanup is incomplete; shut down and restart the Host before retrying",
            )
            .await;
            return ConnectionControl::Continue;
        }
        if shutting_down && request.method != METHOD_SHUTDOWN {
            self.send_error(
                request_id,
                ErrorCode::Cancelled,
                ErrorStage::Protocol,
                false,
                None,
                "SDK Host connection is shutting down",
            )
            .await;
            return ConnectionControl::Continue;
        }

        match request.method.as_str() {
            METHOD_SESSION_CREATE => self.handle_session_create(request).await,
            METHOD_SESSION_RESUME => self.handle_session_resume(request).await,
            METHOD_QUERY_START => self.handle_query_start(request).await,
            METHOD_QUERY_CANCEL => self.handle_query_cancel(request).await,
            METHOD_PERMISSION_RESPOND => self.handle_permission_respond(request).await,
            METHOD_SESSION_CLOSE => self.handle_session_close(request).await,
            METHOD_SHUTDOWN => {
                if self
                    .parse_params::<ShutdownParams>(&request, ErrorStage::Shutdown)
                    .await
                    .is_none()
                {
                    return ConnectionControl::Continue;
                }
                {
                    let mut state = self.inner.state.lock().await;
                    state.shutting_down = true;
                }
                self.send_success(request.id.clone(), ShutdownResult { accepted: true })
                    .await;
                return ConnectionControl::Shutdown;
            }
            _ => {
                self.send_rpc_error(
                    request.id.clone(),
                    -32601,
                    ErrorCode::CapabilityUnavailable,
                    ErrorStage::Protocol,
                    false,
                    None,
                    OutcomeCertainty::NotStarted,
                    None,
                    "method is not supported by this SDK Host",
                )
                .await;
            }
        }
        ConnectionControl::Continue
    }

    /// Emits the protocol-owned overload response when a transport reaches its
    /// bounded in-flight request capacity.
    pub async fn reject_overloaded(&self, request_id: Option<RequestId>) {
        self.send_error(
            request_id,
            ErrorCode::Overloaded,
            ErrorStage::Protocol,
            true,
            Some(RecoveryAction::Retry),
            "SDK Host request capacity is exhausted",
        )
        .await;
    }

    /// Reports whether this connection has completed the required initialize
    /// handshake so a transport can serialize re-initialization safely.
    pub async fn is_initialized(&self) -> bool {
        self.inner.state.lock().await.initialization == InitializationState::Initialized
    }

    async fn reap_finished_pending_session_tasks(&self) {
        let mut state = self.inner.state.lock().await;
        let mut active = Vec::with_capacity(state.pending_session_tasks.len());
        for mut pending in std::mem::take(&mut state.pending_session_tasks) {
            if !pending.task.is_finished() {
                active.push(pending);
                continue;
            }
            if let Some(reservation) = &pending.reservation {
                release_session_task_reservation(&mut state, reservation);
            }
            match (&mut pending.task).now_or_never() {
                Some(Ok(())) => {}
                Some(Err(error)) => {
                    tracing::warn!(
                        error = %error,
                        "SDK Host Session ownership task failed"
                    );
                    if let Some(cleanup) = pending.session_cleanup {
                        state
                            .untracked_session_cleanups
                            .insert(cleanup.session_id.clone(), cleanup);
                    }
                }
                None => active.push(pending),
            }
        }
        state.pending_session_tasks = active;
    }

    pub async fn shutdown_connection(&self) {
        self.shutdown_connection_inner(None).await;
    }

    /// Shuts down one connection without allowing a Session ownership
    /// task to keep the Host process alive indefinitely.
    pub async fn shutdown_connection_bounded(&self, total_timeout: Duration) -> bool {
        self.shutdown_connection_inner(Some(total_timeout)).await
    }

    async fn shutdown_connection_inner(&self, total_timeout: Option<Duration>) -> bool {
        self.inner.shutdown_started.cancel();
        let (pending_session_tasks, prior_cleanup_failed) = {
            let mut state = self.inner.state.lock().await;
            state.shutting_down = true;
            (
                std::mem::take(&mut state.pending_session_tasks),
                state.cleanup_failed,
            )
        };
        let started_at = Instant::now();
        let deadline = total_timeout.map(|timeout| started_at + timeout);
        let graceful_deadline = total_timeout.map(|timeout| started_at + timeout / 2);
        let mut cleanup_complete = !prior_cleanup_failed;
        for pending in pending_session_tasks {
            self.settle_pending_session_task(pending, graceful_deadline)
                .await;
        }
        if !self.compensate_registered_sessions(deadline).await {
            cleanup_complete = false;
        }
        let (queries, sessions) = {
            let mut state = self.inner.state.lock().await;
            for query in state.queries.values() {
                query.stop_forwarding.cancel();
            }
            let queries = std::mem::take(&mut state.queries)
                .into_values()
                .collect::<Vec<_>>();
            state.active_query_sessions.clear();
            state.starting_query_sessions.clear();
            (queries, std::mem::take(&mut state.sessions))
        };

        let mut cancellations = queries
            .into_iter()
            .map(|query| {
                let runtime = self.inner.runtime.clone();
                let cancellation_timeout = deadline
                    .map(|deadline| {
                        deadline
                            .saturating_duration_since(Instant::now())
                            .min(Duration::from_millis(2_500))
                    })
                    .unwrap_or(Duration::from_millis(2_500));
                async move {
                    timeout(
                        cancellation_timeout,
                        runtime.cancel_turn(AgentTurnCancellationRequest {
                            session_id: query.session_id.clone(),
                            turn_id: Some(query.turn_id.clone()),
                            source: Some(AgentSubmissionSource::SdkHost),
                            requester_session_id: None,
                            reason: Some("sdk_host_connection_shutdown".to_string()),
                            wait_timeout_ms: Some(2_000),
                            cancel_descendants: true,
                        }),
                    )
                    .await
                }
            })
            .collect::<FuturesUnordered<_>>();
        while let Some(result) = cancellations.next().await {
            match result {
                Ok(Ok(_)) => {}
                Ok(Err(error)) => {
                    cleanup_complete = false;
                    tracing::warn!(
                        error_kind = runtime_error_kind(&error),
                        "Failed to cancel SDK Host Query during connection shutdown"
                    );
                }
                Err(_) => {
                    cleanup_complete = false;
                    tracing::warn!(
                        "SDK Host Query cancellation timed out during connection shutdown"
                    );
                }
            }
        }

        let mut cleanup = sessions
            .into_iter()
            .map(|(session_id, session)| {
                let connection = self.clone();
                let session_cleanup_timeout = deadline
                    .map(|deadline| {
                        deadline
                            .saturating_duration_since(Instant::now())
                            .min(Duration::from_millis(5_500))
                    })
                    .unwrap_or(Duration::from_millis(5_500));
                async move {
                    let reported_session_id = session_id.clone();
                    let release_kind = session.release_kind();
                    let cleanup = async move {
                        connection
                            .release_runtime_session(
                                session_id.clone(),
                                session.workspace_id,
                                session.workspace_path,
                                session.remote_connection_id,
                                session.remote_ssh_host,
                                release_kind,
                                duration_ms(
                                    session_cleanup_timeout
                                        .saturating_sub(Duration::from_millis(500)),
                                ),
                            )
                            .await?;
                        Ok(())
                    };
                    (
                        reported_session_id,
                        timeout(session_cleanup_timeout, cleanup).await,
                    )
                }
            })
            .collect::<FuturesUnordered<_>>();
        while let Some((session_id, result)) = cleanup.next().await {
            match result {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    cleanup_complete = false;
                    tracing::warn!(
                        session_id = %session_id,
                        error_kind = runtime_error_kind(&error),
                        "Failed to clean up SDK Host Session during connection shutdown"
                    );
                }
                Err(_) => {
                    cleanup_complete = false;
                    tracing::warn!(
                        session_id = %session_id,
                        "SDK Host Session cleanup timed out during connection shutdown"
                    );
                }
            }
        }
        let model_id = {
            let mut state = self.inner.state.lock().await;
            let model_id = state.model_id.take();
            if model_id.is_some() {
                state.initialization = InitializationState::Uninitialized;
            }
            model_id
        };
        if let Some(model_id) = model_id {
            self.inner.temporary_model_installer.remove(&model_id).await;
        }
        cleanup_complete
    }

    async fn settle_pending_session_task(
        &self,
        pending: PendingSessionTask,
        wait_deadline: Option<Instant>,
    ) {
        let PendingSessionTask {
            session_cleanup,
            reservation,
            mut task,
        } = pending;
        let completed = if task.is_finished() {
            Some((&mut task).await)
        } else {
            match wait_deadline {
                Some(deadline) => {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    timeout(remaining, &mut task).await.ok()
                }
                None => Some((&mut task).await),
            }
        };

        match completed {
            Some(Ok(())) => {}
            Some(Err(error)) => {
                tracing::warn!(
                    error = %error,
                    "SDK Host Session ownership task failed"
                );
                if let Some(cleanup) = session_cleanup {
                    self.register_untracked_session_cleanup(cleanup).await;
                }
            }
            None => {
                task.abort();
                let _ = task.await;
                if let Some(cleanup) = session_cleanup {
                    self.register_untracked_session_cleanup(cleanup).await;
                }
            }
        }
        if let Some(reservation) = reservation {
            let mut state = self.inner.state.lock().await;
            release_session_task_reservation(&mut state, &reservation);
        }
    }

    async fn register_untracked_session_cleanup(&self, cleanup: SessionCleanup) {
        self.inner
            .state
            .lock()
            .await
            .untracked_session_cleanups
            .insert(cleanup.session_id.clone(), cleanup);
    }

    async fn compensate_registered_sessions(&self, cleanup_deadline: Option<Instant>) -> bool {
        let cleanups = self
            .inner
            .state
            .lock()
            .await
            .untracked_session_cleanups
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let mut compensations = cleanups
            .into_iter()
            .map(|cleanup| {
                let connection = self.clone();
                async move {
                    let session_id = cleanup.session_id.clone();
                    let completed = connection
                        .compensate_untracked_session(cleanup, cleanup_deadline)
                        .await;
                    (session_id, completed)
                }
            })
            .collect::<FuturesUnordered<_>>();
        let mut cleanup_complete = true;
        while let Some((session_id, completed)) = compensations.next().await {
            if completed {
                self.inner
                    .state
                    .lock()
                    .await
                    .untracked_session_cleanups
                    .remove(&session_id);
            } else {
                cleanup_complete = false;
            }
        }
        cleanup_complete
    }

    async fn compensate_untracked_session(
        &self,
        cleanup: SessionCleanup,
        cleanup_deadline: Option<Instant>,
    ) -> bool {
        let cleanup_timeout = cleanup_deadline
            .map(|deadline| deadline.saturating_duration_since(Instant::now()))
            .unwrap_or(Duration::from_secs(5));
        let result = timeout(
            cleanup_timeout,
            self.release_runtime_session(
                cleanup.session_id.clone(),
                cleanup.workspace_id,
                cleanup.workspace_path,
                None,
                None,
                cleanup.release_kind,
                duration_ms(cleanup_timeout.saturating_sub(Duration::from_millis(500))),
            ),
        )
        .await;
        match result {
            Ok(Ok(_))
            | Ok(Err(RuntimeError::Port(openbitfun_runtime_ports::PortError {
                kind: PortErrorKind::NotFound,
                ..
            }))) => true,
            Ok(Err(error)) => {
                tracing::warn!(
                    session_id = %cleanup.session_id,
                    error_kind = runtime_error_kind(&error),
                    "Failed to compensate an untracked SDK Host Session"
                );
                false
            }
            Err(_) => {
                tracing::warn!(
                    session_id = %cleanup.session_id,
                    "SDK Host Session compensation timed out"
                );
                false
            }
        }
    }

    async fn release_runtime_session(
        &self,
        session_id: String,
        workspace_id: Option<String>,
        workspace_path: String,
        remote_connection_id: Option<String>,
        remote_ssh_host: Option<String>,
        release_kind: SessionReleaseKind,
        wait_timeout_ms: u64,
    ) -> Result<bool, RuntimeError> {
        match release_kind {
            SessionReleaseKind::DiscardTransient => {
                self.inner
                    .runtime
                    .discard_transient_session(AgentSessionReleaseRequest {
                        workspace_id: workspace_id.clone(),
                        workspace_path,
                        session_id,
                        remote_connection_id,
                        remote_ssh_host,
                        wait_timeout_ms,
                    })
                    .await
            }
            SessionReleaseKind::UnloadPersisted => {
                self.inner
                    .runtime
                    .unload_persisted_session(AgentSessionReleaseRequest {
                        workspace_id: workspace_id.clone(),
                        workspace_path,
                        session_id,
                        remote_connection_id,
                        remote_ssh_host,
                        wait_timeout_ms,
                    })
                    .await
            }
            SessionReleaseKind::DeletePersisted => self
                .inner
                .runtime
                .delete_session(AgentSessionDeleteRequest {
                    workspace_id,
                    workspace_path,
                    session_id,
                    remote_connection_id,
                    remote_ssh_host,
                })
                .await
                .map(|_| true),
        }
    }

    async fn handle_initialize(&self, request: JsonRpcRequest) {
        let Some(params) = self
            .parse_params::<InitializeParams>(&request, ErrorStage::Initialize)
            .await
        else {
            return;
        };
        if params.protocol_version != PROTOCOL_VERSION {
            self.send_error(
                request.id.clone(),
                ErrorCode::VersionMismatch,
                ErrorStage::Initialize,
                false,
                Some(RecoveryAction::UpdateSdk),
                "SDK Host protocol version is incompatible",
            )
            .await;
            return;
        }
        if !params.capabilities.server_notifications {
            self.send_error(
                request.id.clone(),
                ErrorCode::CapabilityUnavailable,
                ErrorStage::Initialize,
                false,
                None,
                "query event notifications are required",
            )
            .await;
            return;
        }
        let permission_responses = params.capabilities.permission_responses;
        let initialization_error = {
            let mut state = self.inner.state.lock().await;
            if state.shutting_down {
                Some((ErrorCode::Cancelled, "SDK Host connection is shutting down"))
            } else if state.initialization != InitializationState::Uninitialized {
                Some((
                    ErrorCode::AlreadyInitialized,
                    "SDK Host connection is already initialized",
                ))
            } else {
                state.initialization = InitializationState::Installing;
                None
            }
        };
        if let Some((code, message)) = initialization_error {
            self.send_error(
                request.id.clone(),
                code,
                ErrorStage::Initialize,
                false,
                None,
                message,
            )
            .await;
            return;
        }
        let model_id = match self
            .inner
            .temporary_model_installer
            .install(params.model)
            .await
        {
            Ok(model_id) => model_id,
            Err(error) => {
                let mut state = self.inner.state.lock().await;
                if state.initialization == InitializationState::Installing {
                    state.initialization = InitializationState::Uninitialized;
                }
                drop(state);
                let (code, message) = match error {
                    TemporaryModelInstallError::InvalidModel => (
                        ErrorCode::InvalidRequest,
                        "model provider, model, and apiKey are required",
                    ),
                    TemporaryModelInstallError::InvalidBaseUrl => (
                        ErrorCode::InvalidRequest,
                        "baseUrl must be an absolute http or https URL without credentials, query, or fragment",
                    ),
                    TemporaryModelInstallError::Internal => (
                        ErrorCode::Internal,
                        "SDK Host could not install the temporary model",
                    ),
                };
                self.send_error(
                    request.id.clone(),
                    code,
                    ErrorStage::Initialize,
                    false,
                    None,
                    message,
                )
                .await;
                return;
            }
        };
        let remove_after_shutdown = {
            let mut state = self.inner.state.lock().await;
            if state.shutting_down {
                state.initialization = InitializationState::Uninitialized;
                true
            } else {
                state.model_id = Some(model_id.clone());
                state.permission_responses = permission_responses;
                state.initialization = InitializationState::Initialized;
                false
            }
        };
        if remove_after_shutdown {
            self.inner.temporary_model_installer.remove(&model_id).await;
            self.send_error(
                request.id.clone(),
                ErrorCode::Cancelled,
                ErrorStage::Initialize,
                false,
                None,
                "SDK Host connection is shutting down",
            )
            .await;
            return;
        }
        let mut result = InitializeResult::current(self.inner.runtime_version, model_id);
        result.capabilities.permission_responses = permission_responses;
        self.send_success(request.id.clone(), result).await;
    }

    async fn handle_session_create(&self, request: JsonRpcRequest) {
        let Some(params) = self
            .parse_params::<SessionCreateParams>(&request, ErrorStage::Session)
            .await
        else {
            return;
        };
        let Ok(session_budget) = self.inner.session_budget.clone().try_acquire_owned() else {
            self.send_error(
                request.id.clone(),
                ErrorCode::Overloaded,
                ErrorStage::Session,
                true,
                Some(RecoveryAction::Retry),
                "SDK Host Session capacity is exhausted",
            )
            .await;
            return;
        };
        let workspace_path = params.cwd.unwrap_or_else(|| self.inner.default_cwd.clone());
        let model_id = self.inner.state.lock().await.model_id.clone();
        let result = self
            .create_leased_session(
                AgentSessionCreateRequest {
                    session_name: params
                        .session_name
                        .unwrap_or_else(|| DEFAULT_SESSION_NAME.to_string()),
                    agent_type: params.agent.unwrap_or_else(|| DEFAULT_AGENT.to_string()),
                    agent_route_key: None,
                    workspace_path: Some(workspace_path.clone()),
                    project_workspace_path: None,
                    execution_target: None,
                    workspace_id: None,
                    remote_connection_id: None,
                    remote_ssh_host: None,
                    model_id,
                    metadata: serde_json::Map::new(),
                },
                workspace_path,
                session_budget,
                SessionLifetime::Durable,
            )
            .await;
        match result {
            Ok(created) => {
                let session_id = created.session_id.clone();
                self.deliver_session_create_response(
                    request.id.clone(),
                    created,
                    session_id,
                    SessionLifetime::Durable,
                )
                .await;
            }
            Err(error) => {
                self.send_runtime_error(request.id.clone(), ErrorStage::Session, error)
                    .await
            }
        }
    }

    async fn handle_session_resume(&self, request: JsonRpcRequest) {
        let Some(params) = self
            .parse_params::<SessionResumeParams>(&request, ErrorStage::Session)
            .await
        else {
            return;
        };
        if params.session_id.trim().is_empty() {
            self.send_invalid_params(
                request.id.clone(),
                ErrorStage::Session,
                "sessionId must not be empty",
            )
            .await;
            return;
        }
        let Ok(session_budget) = self.inner.session_budget.clone().try_acquire_owned() else {
            self.send_error(
                request.id.clone(),
                ErrorCode::Overloaded,
                ErrorStage::Session,
                true,
                Some(RecoveryAction::Retry),
                "SDK Host Session capacity is exhausted",
            )
            .await;
            return;
        };
        let workspace_path = self.inner.default_cwd.clone();
        let Some(model_id) = self.inner.state.lock().await.model_id.clone() else {
            self.send_runtime_error(
                request.id.clone(),
                ErrorStage::Session,
                PortError::new(
                    PortErrorKind::NotAvailable,
                    "SDK Host model is not initialized",
                )
                .into(),
            )
            .await;
            return;
        };
        let session_id = params.session_id;
        match self
            .restore_leased_session(session_id.clone(), workspace_path, model_id, session_budget)
            .await
        {
            Ok(restored) => {
                self.deliver_session_create_response(
                    request.id.clone(),
                    restored,
                    session_id,
                    SessionLifetime::Durable,
                )
                .await;
            }
            Err(error) => {
                self.send_runtime_error(request.id.clone(), ErrorStage::Session, error)
                    .await;
            }
        }
    }

    async fn handle_query_start(&self, request: JsonRpcRequest) {
        let emit_output = request.id.is_some();
        let Some(params) = self
            .parse_params::<QueryStartParams>(&request, ErrorStage::Query)
            .await
        else {
            return;
        };
        if params.prompt.trim().is_empty() && params.images.is_empty() {
            self.send_invalid_params(
                request.id.clone(),
                ErrorStage::Query,
                "prompt and images must not both be empty",
            )
            .await;
            return;
        }
        if params.images.iter().any(|path| !is_local_image_path(path)) {
            self.send_invalid_params(
                request.id.clone(),
                ErrorStage::Query,
                "images must contain non-empty local paths with png, jpg, jpeg, gif, or webp extensions",
            )
            .await;
            return;
        }
        if params
            .output_schema
            .as_ref()
            .is_some_and(|schema| !schema.is_object())
        {
            self.send_invalid_params(
                request.id.clone(),
                ErrorStage::Query,
                "outputSchema must be a JSON object",
            )
            .await;
            return;
        }
        if params.session_id.is_some()
            && (params.session_name.is_some()
                || params.agent.is_some()
                || params.cwd.is_some()
                || params.model.is_some())
        {
            self.send_invalid_params(
                request.id.clone(),
                ErrorStage::Query,
                "sessionName, agent, cwd, and model are only valid when creating a Session",
            )
            .await;
            return;
        }
        let Ok(query_budget) = self.inner.query_budget.clone().try_acquire_owned() else {
            self.send_error(
                request.id.clone(),
                ErrorCode::Overloaded,
                ErrorStage::Query,
                true,
                Some(RecoveryAction::Retry),
                "SDK Host active Query capacity is exhausted",
            )
            .await;
            return;
        };

        let (session_id, agent_type, created_session) = match params.session_id.clone() {
            Some(session_id) => {
                let lease = match self.ensure_session_lease(&session_id).await {
                    Ok(lease) => lease,
                    Err(error) => {
                        self.send_runtime_error(request.id.clone(), ErrorStage::Session, error)
                            .await;
                        return;
                    }
                };
                let agent_type = match self
                    .inner
                    .runtime
                    .resolve_session_agent_type(&session_id)
                    .await
                {
                    Ok(Some(agent_type)) => agent_type,
                    Ok(None) => DEFAULT_AGENT.to_string(),
                    Err(error) => {
                        drop(lease);
                        self.send_runtime_error(request.id.clone(), ErrorStage::Session, error)
                            .await;
                        return;
                    }
                };
                (session_id, agent_type, false)
            }
            None => {
                let Ok(session_budget) = self.inner.session_budget.clone().try_acquire_owned()
                else {
                    self.send_error(
                        request.id.clone(),
                        ErrorCode::Overloaded,
                        ErrorStage::Session,
                        true,
                        Some(RecoveryAction::Retry),
                        "SDK Host Session capacity is exhausted",
                    )
                    .await;
                    return;
                };
                let workspace_path = params
                    .cwd
                    .clone()
                    .unwrap_or_else(|| self.inner.default_cwd.clone());
                let model_id = self.inner.state.lock().await.model_id.clone();
                match self
                    .create_leased_session(
                        AgentSessionCreateRequest {
                            session_name: params
                                .session_name
                                .clone()
                                .unwrap_or_else(|| DEFAULT_SESSION_NAME.to_string()),
                            agent_type: params
                                .agent
                                .clone()
                                .unwrap_or_else(|| DEFAULT_AGENT.to_string()),
                            agent_route_key: None,
                            workspace_path: Some(workspace_path.clone()),
                            project_workspace_path: None,
                            execution_target: None,
                            workspace_id: None,
                            remote_connection_id: None,
                            remote_ssh_host: None,
                            model_id,
                            metadata: serde_json::Map::new(),
                        },
                        workspace_path,
                        session_budget,
                        SessionLifetime::Connection,
                    )
                    .await
                {
                    Ok(created) => {
                        let agent_type = created.agent_type.clone();
                        (created.session_id, agent_type, true)
                    }
                    Err(error) => {
                        self.send_runtime_error(request.id.clone(), ErrorStage::Session, error)
                            .await;
                        return;
                    }
                }
            }
        };

        let session = match self.reserve_query_session(&session_id).await {
            Ok(session) => session,
            Err(reservation_error) => {
                if created_session && self.release_unexposed_session(&session_id).await.is_err() {
                    self.send_cleanup_required(request.id.clone(), ErrorStage::Query, &session_id)
                        .await;
                    return;
                }
                match reservation_error {
                    QueryReservationError::Unavailable => {
                        self.send_error(
                            request.id.clone(),
                            ErrorCode::Overloaded,
                            ErrorStage::Query,
                            true,
                            Some(RecoveryAction::Retry),
                            "Session cannot accept a new Query while another Query, close, or shutdown is active",
                        )
                        .await;
                    }
                    QueryReservationError::Poisoned => {
                        self.send_cleanup_required(
                            request.id.clone(),
                            ErrorStage::Query,
                            &session_id,
                        )
                        .await;
                    }
                }
                return;
            }
        };
        let session_lifetime = session.lifetime;

        let mut events = match self.inner.runtime.subscribe_session_events(&session_id) {
            Ok(events) => events,
            Err(error) => {
                self.release_query_session(&session_id).await;
                if created_session && self.release_unexposed_session(&session_id).await.is_err() {
                    self.send_cleanup_required(request.id.clone(), ErrorStage::Query, &session_id)
                        .await;
                    return;
                }
                self.send_runtime_error(request.id.clone(), ErrorStage::Query, error)
                    .await;
                return;
            }
        };
        let mut permission_events = match self.inner.runtime.subscribe_permission_requests() {
            Ok(events) => events,
            Err(error) => {
                self.release_query_session(&session_id).await;
                if created_session && self.release_unexposed_session(&session_id).await.is_err() {
                    self.send_cleanup_required(request.id.clone(), ErrorStage::Query, &session_id)
                        .await;
                    return;
                }
                self.send_runtime_error(request.id.clone(), ErrorStage::Query, error)
                    .await;
                return;
            }
        };
        let mut submission_metadata = serde_json::Map::new();
        submission_metadata.insert(
            USER_INPUT_AVAILABLE_CONTEXT_KEY.to_string(),
            serde_json::Value::Bool(false),
        );
        submission_metadata.insert(
            AUTO_APPROVE_ASK_CONTEXT_KEY.to_string(),
            serde_json::Value::Bool(false),
        );
        let attachments = params
            .images
            .iter()
            .map(|image_path| local_image_attachment(image_path, &session.workspace_path))
            .collect();
        let submitted = match self
            .inner
            .runtime
            .submit_dialog_turn(AgentDialogTurnRequest {
                session_id: session_id.clone(),
                message: params.prompt,
                output_schema: params.output_schema.clone(),
                original_message: None,
                turn_id: None,
                execution: Default::default(),
                agent_type,
                workspace_path: Some(session.workspace_path.clone()),
                workspace_id: session.workspace_id.clone(),
                remote_connection_id: session.remote_connection_id.clone(),
                remote_ssh_host: session.remote_ssh_host.clone(),
                policy: DialogSubmissionPolicy::for_source(AgentSubmissionSource::SdkHost),
                reply_route: None,
                prepended_reminders: Vec::new(),
                attachments,
                metadata: submission_metadata,
            })
            .await
        {
            Ok(outcome) => outcome,
            Err(error) => {
                self.release_query_session(&session_id).await;
                if created_session && self.release_unexposed_session(&session_id).await.is_err() {
                    self.send_cleanup_required(request.id.clone(), ErrorStage::Query, &session_id)
                        .await;
                    return;
                }
                self.send_runtime_error(request.id.clone(), ErrorStage::Query, error)
                    .await;
                return;
            }
        };
        let (submitted_session_id, turn_id) = match submitted {
            DialogSubmitOutcome::Started {
                session_id,
                turn_id,
            } => (session_id, turn_id),
            DialogSubmitOutcome::Queued {
                session_id,
                turn_id,
            } => (session_id, turn_id),
        };
        let query_id = format!("query_{}", uuid::Uuid::new_v4());
        let operation_id = format!("operation_{}", uuid::Uuid::new_v4());
        let lease = Arc::new(QueryLease {
            query_id: query_id.clone(),
            session_id: submitted_session_id.clone(),
            turn_id: turn_id.clone(),
            operation_id: operation_id.clone(),
            event_budget: StdMutex::new(QueryEventBudget::default()),
            structured_output_requested: params.output_schema.is_some(),
            usage: StdMutex::new(None),
            terminal: AtomicBool::new(false),
            stop_forwarding: CancellationToken::new(),
            emit_output,
            pending_permissions: StdMutex::new(HashMap::new()),
            _budget: query_budget,
        });
        {
            let mut state = self.inner.state.lock().await;
            state.queries.insert(query_id.clone(), lease.clone());
            state.starting_query_sessions.remove(&session_id);
            state.active_query_sessions.insert(session_id.clone());
        }

        let start_delivered = self
            .deliver_query_start_response(
                request.id.clone(),
                QueryStartResult {
                    query_id: query_id.clone(),
                    session_id: submitted_session_id.clone(),
                    turn_id: turn_id.clone(),
                    operation_id,
                    accepted: true,
                    created_session,
                    session_lifetime,
                },
                lease.clone(),
                created_session,
            )
            .await;
        if !start_delivered {
            return;
        }

        let connection = self.clone();
        tokio::spawn(async move {
            let mut sequence = 0u64;
            loop {
                let envelope = tokio::select! {
                    _ = lease.stop_forwarding.cancelled() => return,
                    permission = permission_events.recv() => {
                        match permission {
                            Ok(PermissionRequestEvent::Asked { request })
                                if permission_request_targets_query(
                                    &request,
                                    connection
                                        .inner
                                        .runtime
                                        .permission_request_dialog_turn_id(&request.request_id)
                                        .ok()
                                        .flatten()
                                        .as_deref(),
                                    &lease,
                                ) =>
                            {
                                if !connection
                                    .forward_permission_request(&lease, &request, &mut sequence)
                                    .await
                                {
                                    return;
                                }
                                continue;
                            }
                            Ok(PermissionRequestEvent::Replied { request_id, .. })
                            | Ok(PermissionRequestEvent::Cancelled { request_id, .. }) => {
                                if let Some(timeout_cancel) = lease
                                    .pending_permissions
                                    .lock()
                                    .expect("SDK Host pending permission lock poisoned")
                                    .remove(&request_id)
                                {
                                    timeout_cancel.cancel();
                                }
                                continue;
                            }
                            Ok(_) => continue,
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                                match connection.inner.runtime.pending_permission_requests() {
                                    Ok(pending) => {
                                        let pending = pending
                                            .into_iter()
                                            .filter(|request| {
                                                permission_request_targets_query(
                                                    request,
                                                    connection
                                                        .inner
                                                        .runtime
                                                        .permission_request_dialog_turn_id(
                                                            &request.request_id,
                                                        )
                                                        .ok()
                                                        .flatten()
                                                        .as_deref(),
                                                    &lease,
                                                )
                                            })
                                            .collect::<Vec<_>>();
                                        let authoritative = pending
                                            .iter()
                                            .map(|request| request.request_id.as_str())
                                            .collect::<HashSet<_>>();
                                        {
                                            let mut tracked = lease
                                                .pending_permissions
                                                .lock()
                                                .expect("SDK Host pending permission lock poisoned");
                                            tracked.retain(|request_id, timeout_cancel| {
                                                let keep = authoritative
                                                    .contains(request_id.as_str());
                                                if !keep {
                                                    timeout_cancel.cancel();
                                                }
                                                keep
                                            });
                                        }
                                        for request in pending {
                                            if !connection
                                                .forward_permission_request(
                                                    &lease,
                                                    &request,
                                                    &mut sequence,
                                                )
                                                .await
                                            {
                                                return;
                                            }
                                        }
                                        continue;
                                    }
                                    Err(error) => {
                                        connection.cancel_and_finish(
                                            &lease,
                                            query_error_from_runtime(
                                                &lease.query_id,
                                                error,
                                                "SDK Host could not recover permission requests after event lag",
                                            ),
                                            true,
                                        ).await;
                                        return;
                                    }
                                }
                            }
                            Err(_) => {
                                connection.cancel_and_finish(
                                    &lease,
                                    QueryResultError::new(
                                        ErrorCode::Internal,
                                        true,
                                        Some(RecoveryAction::RestartHost),
                                        &lease.query_id,
                                        "SDK Host permission event stream is unavailable",
                                    ),
                                    true,
                                ).await;
                                return;
                            }
                        }
                    }
                    event = events.recv() => match event {
                        Ok(event) => event,
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                            connection.cancel_and_finish(
                                &lease,
                                QueryResultError::new(
                                    ErrorCode::Internal,
                                    true,
                                    Some(RecoveryAction::RestartHost),
                                    &lease.query_id,
                                    "SDK Host event stream lagged",
                                ),
                                true,
                            ).await;
                            return;
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                            connection.cancel_and_finish(
                                &lease,
                                QueryResultError::new(
                                    ErrorCode::Internal,
                                    true,
                                    Some(RecoveryAction::RestartHost),
                                    &lease.query_id,
                                    "SDK Host event stream closed",
                                ),
                                true,
                            ).await;
                            return;
                        }
                    }
                };
                if event_turn_id(&envelope.event) != Some(lease.turn_id.as_str()) {
                    continue;
                }
                TurnTokenUsage::accumulate_event(
                    &mut lease
                        .usage
                        .lock()
                        .expect("SDK Host Query usage lock poisoned"),
                    &envelope.event,
                    &lease.turn_id,
                );
                let terminal = terminal_fact(&envelope.event, &lease.turn_id, &lease.query_id);
                if lease.emit_output {
                    if let Some(projected) = project_query_event(&envelope.event) {
                        if let QueryEvent::AssistantTextDelta { text } = &projected {
                            let output_exceeded = {
                                let mut event_budget = lease
                                    .event_budget
                                    .lock()
                                    .expect("SDK Host Query event budget lock poisoned");
                                let structured_attempt =
                                    lease.structured_output_requested.then(|| {
                                        match &envelope.event {
                                            AgenticEvent::TextChunk {
                                                round_id,
                                                attempt_id,
                                                attempt_index,
                                                ..
                                            } => QueryOutputAttempt {
                                                round_id: round_id.clone(),
                                                attempt_id: attempt_id.clone(),
                                                attempt_index: *attempt_index,
                                            },
                                            _ => unreachable!(
                                                "assistant text projection requires TextChunk"
                                            ),
                                        }
                                    });
                                !event_budget.observe(text, structured_attempt)
                            };
                            if output_exceeded {
                                connection
                                    .cancel_and_finish(
                                        &lease,
                                        QueryResultError::new(
                                            ErrorCode::Overloaded,
                                            false,
                                            None,
                                            &lease.query_id,
                                            "SDK Host Query output exceeded the protocol size limit",
                                        ),
                                        true,
                                    )
                                    .await;
                                return;
                            }
                        }
                        sequence += 1;
                        if !connection
                            .send_notification(
                                NOTIFICATION_QUERY_EVENT,
                                QueryEventParams {
                                    query_id: lease.query_id.clone(),
                                    session_id: lease.session_id.clone(),
                                    turn_id: lease.turn_id.clone(),
                                    operation_id: lease.operation_id.clone(),
                                    sequence,
                                    event: projected,
                                },
                            )
                            .await
                        {
                            connection
                                .cancel_and_finish(
                                    &lease,
                                    QueryResultError::new(
                                        ErrorCode::ProcessLost,
                                        false,
                                        None,
                                        &lease.query_id,
                                        "SDK Host output is unavailable",
                                    ),
                                    false,
                                )
                                .await;
                            return;
                        }
                    }
                }
                if let Some((status, error)) = terminal {
                    connection
                        .finish_query(&lease, status, error, true, false)
                        .await;
                    return;
                }
            }
        });
    }

    async fn handle_query_cancel(&self, request: JsonRpcRequest) {
        let Some(params) = self
            .parse_params::<QueryCancelParams>(&request, ErrorStage::Query)
            .await
        else {
            return;
        };
        let lease = self
            .inner
            .state
            .lock()
            .await
            .queries
            .get(&params.query_id)
            .cloned();
        let Some(lease) = lease else {
            self.send_success(
                request.id.clone(),
                QueryCancelResult {
                    query_id: params.query_id,
                    session_id: params.session_id,
                    turn_id: params.turn_id,
                    operation_id: params.operation_id,
                    requested: false,
                },
            )
            .await;
            return;
        };
        if lease.session_id != params.session_id
            || lease.turn_id != params.turn_id
            || lease.operation_id != params.operation_id
        {
            self.send_invalid_params(
                request.id.clone(),
                ErrorStage::Query,
                "Query cancellation identity does not match the accepted Query",
            )
            .await;
            return;
        }
        match timeout(
            Duration::from_millis(2_500),
            self.inner
                .runtime
                .cancel_turn(AgentTurnCancellationRequest {
                    session_id: lease.session_id.clone(),
                    turn_id: Some(lease.turn_id.clone()),
                    source: Some(AgentSubmissionSource::SdkHost),
                    requester_session_id: None,
                    reason: Some("sdk_query_cancel".to_string()),
                    wait_timeout_ms: Some(2_000),
                    cancel_descendants: true,
                }),
        )
        .await
        {
            Ok(Ok(result)) => {
                self.send_success(
                    request.id.clone(),
                    QueryCancelResult {
                        query_id: lease.query_id.clone(),
                        session_id: lease.session_id.clone(),
                        turn_id: lease.turn_id.clone(),
                        operation_id: lease.operation_id.clone(),
                        requested: result.requested,
                    },
                )
                .await;
            }
            Ok(Err(error)) => {
                self.send_runtime_uncertain_error(
                    request.id.clone(),
                    ErrorStage::Query,
                    Some(lease.operation_id.clone()),
                    error,
                )
                .await
            }
            Err(_) => {
                self.send_uncertain_error(
                    request.id.clone(),
                    ErrorCode::Timeout,
                    ErrorStage::Query,
                    true,
                    Some(lease.operation_id.clone()),
                    Some(RecoveryAction::Retry),
                    "SDK Host Query cancellation timed out",
                )
                .await;
            }
        }
    }

    async fn handle_permission_respond(&self, request: JsonRpcRequest) {
        let Some(mut params) = self
            .parse_params::<PermissionRespondParams>(&request, ErrorStage::Query)
            .await
        else {
            return;
        };
        if params.decision != PermissionDecision::Reject && params.feedback.is_some() {
            self.send_invalid_params(
                request.id.clone(),
                ErrorStage::Query,
                "feedback is only valid when rejecting a permission request",
            )
            .await;
            return;
        }
        if params
            .feedback
            .as_ref()
            .is_some_and(|feedback| feedback.len() > MAX_PERMISSION_FEEDBACK_BYTES)
        {
            self.send_invalid_params(
                request.id.clone(),
                ErrorStage::Query,
                "Permission rejection feedback exceeds the size limit",
            )
            .await;
            return;
        }
        params.feedback = params
            .feedback
            .map(|feedback| feedback.trim().to_string())
            .filter(|feedback| !feedback.is_empty());
        let (permission_responses, lease) = {
            let state = self.inner.state.lock().await;
            (
                state.permission_responses,
                state.queries.get(&params.query_id).cloned(),
            )
        };
        if !permission_responses {
            self.send_error(
                request.id.clone(),
                ErrorCode::CapabilityUnavailable,
                ErrorStage::Query,
                false,
                None,
                "permission responses were not negotiated for this connection",
            )
            .await;
            return;
        }
        let Some(lease) = lease else {
            self.send_error(
                request.id.clone(),
                ErrorCode::NotFound,
                ErrorStage::Query,
                false,
                None,
                "Query is not active on this SDK Host connection",
            )
            .await;
            return;
        };
        if lease.session_id != params.session_id
            || lease.turn_id != params.turn_id
            || lease.operation_id != params.operation_id
        {
            self.send_invalid_params(
                request.id.clone(),
                ErrorStage::Query,
                "Permission response identity does not match the owning Query",
            )
            .await;
            return;
        }
        let timeout_cancel = lease
            .pending_permissions
            .lock()
            .expect("SDK Host pending permission lock poisoned")
            .remove(&params.request_id);
        let Some(timeout_cancel) = timeout_cancel else {
            self.send_error(
                request.id.clone(),
                ErrorCode::NotFound,
                ErrorStage::Query,
                false,
                None,
                "Permission request is unknown, expired, or already answered",
            )
            .await;
            return;
        };
        timeout_cancel.cancel();
        let reply = match params.decision {
            PermissionDecision::AllowOnce => PermissionReply::Once,
            PermissionDecision::AllowAlways => PermissionReply::Always,
            PermissionDecision::Reject => PermissionReply::Reject {
                feedback: params.feedback,
            },
        };
        match timeout(
            Duration::from_millis(PERMISSION_REJECTION_TIMEOUT_MS),
            self.inner.runtime.respond_permission_with_source(
                &params.request_id,
                reply,
                PermissionReplySource::User,
            ),
        )
        .await
        {
            Ok(Ok(())) => {
                self.send_success(
                    request.id.clone(),
                    PermissionRespondResult {
                        request_id: params.request_id,
                        accepted: true,
                    },
                )
                .await;
            }
            Ok(Err(error)) => {
                self.cancel_and_finish(
                    &lease,
                    query_error_from_runtime(
                        &lease.query_id,
                        error,
                        "SDK Host permission response failed",
                    ),
                    true,
                )
                .await;
                self.send_error(
                    request.id.clone(),
                    ErrorCode::Internal,
                    ErrorStage::Query,
                    false,
                    None,
                    "Permission response failed and the Query was cancelled",
                )
                .await;
            }
            Err(_) => {
                self.cancel_and_finish(
                    &lease,
                    QueryResultError::new(
                        ErrorCode::Timeout,
                        false,
                        None,
                        &lease.query_id,
                        "SDK Host permission response timed out",
                    ),
                    true,
                )
                .await;
                self.send_error(
                    request.id.clone(),
                    ErrorCode::Timeout,
                    ErrorStage::Query,
                    false,
                    None,
                    "Permission response outcome is unknown and the Query was cancelled",
                )
                .await;
            }
        }
    }

    async fn handle_session_close(&self, request: JsonRpcRequest) {
        let Some(params) = self
            .parse_params::<SessionCloseParams>(&request, ErrorStage::Session)
            .await
        else {
            return;
        };
        if params
            .wait_timeout_ms
            .is_some_and(|timeout| timeout == 0 || timeout > MAX_SESSION_CLOSE_TIMEOUT_MS)
        {
            self.send_invalid_params(
                request.id.clone(),
                ErrorStage::Session,
                "waitTimeoutMs must be between 1 and 30000",
            )
            .await;
            return;
        }
        let close_timeout_ms = params.wait_timeout_ms.unwrap_or(5_000);
        if !self
            .wait_for_session_publication(
                &params.session_id,
                Duration::from_millis(close_timeout_ms.min(MAX_SESSION_PUBLICATION_WAIT_MS)),
            )
            .await
        {
            self.send_error(
                request.id.clone(),
                ErrorCode::Timeout,
                ErrorStage::Session,
                true,
                Some(RecoveryAction::Retry),
                "Timed out waiting for Session creation or resume response to commit",
            )
            .await;
            return;
        }
        let session = {
            let mut state = self.inner.state.lock().await;
            if state.closing_sessions.contains(&params.session_id) {
                drop(state);
                self.send_error(
                    request.id.clone(),
                    ErrorCode::Overloaded,
                    ErrorStage::Session,
                    true,
                    Some(RecoveryAction::Retry),
                    "Session close is already in progress",
                )
                .await;
                return;
            }
            if state.starting_query_sessions.contains(&params.session_id) {
                drop(state);
                self.send_error(
                    request.id.clone(),
                    ErrorCode::Overloaded,
                    ErrorStage::Session,
                    true,
                    Some(RecoveryAction::Retry),
                    "Session has a Query start in progress",
                )
                .await;
                return;
            }
            let session = state.sessions.get(&params.session_id).cloned();
            if session.is_some() {
                state.closing_sessions.insert(params.session_id.clone());
            }
            session
        };
        let Some(session) = session else {
            self.send_error(
                request.id.clone(),
                ErrorCode::NotFound,
                ErrorStage::Session,
                false,
                None,
                "Session is not owned by this SDK Host connection",
            )
            .await;
            return;
        };
        let session_id = params.session_id.clone();
        let release_kind = session.release_kind();
        let operation = self.release_runtime_session(
            session_id,
            session.workspace_id,
            session.workspace_path,
            session.remote_connection_id,
            session.remote_ssh_host,
            release_kind,
            close_timeout_ms,
        );
        match timeout(Duration::from_millis(close_timeout_ms + 500), operation).await {
            Ok(Ok(unloaded)) => {
                let queries = {
                    let mut state = self.inner.state.lock().await;
                    state.sessions.remove(&params.session_id);
                    state.closing_sessions.remove(&params.session_id);
                    state.poisoned_sessions.remove(&params.session_id);
                    state.starting_query_sessions.remove(&params.session_id);
                    state.active_query_sessions.remove(&params.session_id);
                    let query_ids = state
                        .queries
                        .iter()
                        .filter(|(_, lease)| lease.session_id == params.session_id)
                        .map(|(query_id, _)| query_id.clone())
                        .collect::<Vec<_>>();
                    query_ids
                        .into_iter()
                        .filter_map(|query_id| state.queries.remove(&query_id))
                        .collect::<Vec<_>>()
                };
                for query in queries {
                    query.stop_forwarding.cancel();
                    self.finish_query(&query, QueryTerminalStatus::Cancelled, None, true, false)
                        .await;
                }
                self.send_success(
                    request.id.clone(),
                    SessionCloseResult {
                        session_id: params.session_id,
                        unloaded,
                    },
                )
                .await;
            }
            Ok(Err(error)) => {
                tracing::warn!(
                    session_id = %params.session_id,
                    error_kind = runtime_error_kind(&error),
                    "SDK Host Session close ended with uncertain cleanup"
                );
                self.mark_session_cleanup_failed(&params.session_id).await;
                self.send_uncertain_error(
                    request.id.clone(),
                    ErrorCode::CleanupRequired,
                    ErrorStage::Session,
                    false,
                    None,
                    Some(RecoveryAction::RestartHost),
                    "SDK Host Session cleanup is incomplete; restart the Host before retrying",
                )
                .await;
            }
            Err(_) => {
                tracing::warn!(
                    session_id = %params.session_id,
                    "SDK Host Session close timed out with uncertain cleanup"
                );
                self.mark_session_cleanup_failed(&params.session_id).await;
                self.send_uncertain_error(
                    request.id.clone(),
                    ErrorCode::CleanupRequired,
                    ErrorStage::Session,
                    false,
                    None,
                    Some(RecoveryAction::RestartHost),
                    "SDK Host Session cleanup timed out; restart the Host before retrying",
                )
                .await;
            }
        }
    }

    async fn mark_session_cleanup_failed(&self, session_id: &str) {
        let mut state = self.inner.state.lock().await;
        state.closing_sessions.remove(session_id);
        state.poisoned_sessions.insert(session_id.to_string());
        state.cleanup_failed = true;
    }

    async fn wait_for_session_publication(&self, session_id: &str, wait_timeout: Duration) -> bool {
        timeout(wait_timeout, async {
            loop {
                self.reap_finished_pending_session_tasks().await;
                if !self
                    .inner
                    .state
                    .lock()
                    .await
                    .publishing_sessions
                    .contains(session_id)
                {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .is_ok()
    }

    async fn ensure_session_lease(&self, session_id: &str) -> Result<SessionLease, RuntimeError> {
        self.inner
            .state
            .lock()
            .await
            .sessions
            .get(session_id)
            .cloned()
            .ok_or_else(|| {
                openbitfun_runtime_ports::PortError::new(
                    PortErrorKind::NotAvailable,
                    "sessionId must be created or resumed on this SDK Host connection before starting a Query",
                )
                .into()
            })
    }

    async fn create_leased_session(
        &self,
        request: AgentSessionCreateRequest,
        workspace_path: String,
        session_budget: OwnedSemaphorePermit,
        lifetime: SessionLifetime,
    ) -> Result<openbitfun_agent_runtime::sdk::AgentSessionCreateResult, RuntimeError> {
        let session_id = uuid::Uuid::new_v4().to_string();
        let runtime = self.inner.runtime.clone();
        let state = self.inner.state.clone();
        let task_state = state.clone();
        let (result_tx, result_rx) = oneshot::channel();
        let mut connection_state = state.lock().await;
        if connection_state.shutting_down {
            return Err(openbitfun_runtime_ports::PortError::new(
                PortErrorKind::Cancelled,
                "SDK Host connection is shutting down",
            )
            .into());
        }
        let task_session_id = session_id.clone();
        let cleanup_workspace_path = workspace_path.clone();
        let creation = tokio::spawn(async move {
            let result = match lifetime {
                SessionLifetime::Connection => {
                    runtime
                        .create_transient_session_with_id(task_session_id, request)
                        .await
                }
                SessionLifetime::Durable => {
                    runtime
                        .create_session_with_id(task_session_id, request)
                        .await
                }
            };
            if let Ok(created) = &result {
                task_state.lock().await.sessions.insert(
                    created.session_id.clone(),
                    SessionLease {
                        workspace_id: created.workspace_id.clone(),
                        workspace_path,
                        remote_connection_id: None,
                        remote_ssh_host: None,
                        exposed: false,
                        lifetime,
                        unexposed_release: match lifetime {
                            SessionLifetime::Connection => SessionReleaseKind::DiscardTransient,
                            SessionLifetime::Durable => SessionReleaseKind::DeletePersisted,
                        },
                        _budget: Arc::new(session_budget),
                    },
                );
            }
            let _ = result_tx.send(result);
        });
        connection_state
            .pending_session_tasks
            .push(PendingSessionTask {
                session_cleanup: Some(SessionCleanup {
                    session_id,
                    workspace_id: None,
                    workspace_path: cleanup_workspace_path,
                    release_kind: match lifetime {
                        SessionLifetime::Connection => SessionReleaseKind::DiscardTransient,
                        SessionLifetime::Durable => SessionReleaseKind::DeletePersisted,
                    },
                }),
                reservation: None,
                task: creation,
            });
        drop(connection_state);
        result_rx.await.map_err(|_| {
            RuntimeError::from(openbitfun_runtime_ports::PortError::new(
                PortErrorKind::Backend,
                "SDK Host Session creation task ended without a result",
            ))
        })?
    }

    async fn restore_leased_session(
        &self,
        session_id: String,
        workspace_path: String,
        model_id: String,
        session_budget: OwnedSemaphorePermit,
    ) -> Result<AgentSessionCreateResult, RuntimeError> {
        let runtime = self.inner.runtime.clone();
        let state = self.inner.state.clone();
        let task_state = state.clone();
        let (result_tx, result_rx) = oneshot::channel();
        let mut connection_state = state.lock().await;
        if connection_state.shutting_down {
            return Err(PortError::new(
                PortErrorKind::Cancelled,
                "SDK Host connection is shutting down",
            )
            .into());
        }
        if connection_state.sessions.contains_key(&session_id)
            || !connection_state
                .attaching_sessions
                .insert(session_id.clone())
        {
            return Err(PortError::new(
                PortErrorKind::InvalidRequest,
                "Session is already attached to this SDK Host connection",
            )
            .into());
        }
        let task_session_id = session_id.clone();
        let task_workspace_path = workspace_path.clone();
        let cleanup_workspace_path = workspace_path.clone();
        let restoration = tokio::spawn(async move {
            let restored = runtime
                .restore_session(AgentSessionRestoreRequest {
                    workspace_id: None,
                    workspace_path: task_workspace_path.clone(),
                    session_id: task_session_id.clone(),
                    include_internal: false,
                    remote_connection_id: None,
                    remote_ssh_host: None,
                })
                .await;
            let result = match restored {
                Err(error) => Err(error),
                Ok(restored) => {
                    let prepared = async {
                        runtime
                            .update_session_model(AgentSessionModelUpdateRequest {
                                session_id: task_session_id.clone(),
                                model_id: model_id.clone(),
                            })
                            .await?;
                        let binding = runtime
                            .resolve_session_workspace_binding(AgentSessionWorkspaceRequest {
                                session_id: task_session_id.clone(),
                            })
                            .await?;
                        let mut result = AgentSessionCreateResult::new(
                            restored.session.session_id,
                            restored.session.session_name,
                            restored.session.agent_type,
                        );
                        result.model_id = Some(model_id);
                        if let Some(binding) = binding {
                            result.workspace_path = Some(binding.workspace_path);
                            result.workspace_id = binding.workspace_id;
                            result.project_workspace_path = binding.project_workspace_path;
                            result.execution_target = binding.execution_target;
                        } else {
                            result.workspace_path = Some(task_workspace_path.clone());
                        }
                        Ok(result)
                    }
                    .await;
                    if prepared.is_err() {
                        let release = runtime
                            .unload_persisted_session(AgentSessionReleaseRequest {
                                workspace_id: None,
                                workspace_path: task_workspace_path.clone(),
                                session_id: task_session_id.clone(),
                                remote_connection_id: None,
                                remote_ssh_host: None,
                                wait_timeout_ms: 4_500,
                            })
                            .await;
                        if release.is_err() {
                            task_state.lock().await.untracked_session_cleanups.insert(
                                task_session_id.clone(),
                                SessionCleanup {
                                    session_id: task_session_id.clone(),
                                    workspace_id: None,
                                    workspace_path: task_workspace_path.clone(),
                                    release_kind: SessionReleaseKind::UnloadPersisted,
                                },
                            );
                            Err(PortError::new(
                                PortErrorKind::CleanupRequired,
                                "Restored Session could not be prepared or released",
                            )
                            .into())
                        } else {
                            prepared
                        }
                    } else {
                        prepared
                    }
                }
            };
            let mut connection_state = task_state.lock().await;
            if let Ok(restored) = &result {
                connection_state.sessions.insert(
                    restored.session_id.clone(),
                    SessionLease {
                        workspace_id: restored.workspace_id.clone(),
                        workspace_path,
                        remote_connection_id: None,
                        remote_ssh_host: None,
                        exposed: false,
                        lifetime: SessionLifetime::Durable,
                        unexposed_release: SessionReleaseKind::UnloadPersisted,
                        _budget: Arc::new(session_budget),
                    },
                );
            }
            drop(connection_state);
            let _ = result_tx.send(result);
        });
        connection_state
            .pending_session_tasks
            .push(PendingSessionTask {
                session_cleanup: Some(SessionCleanup {
                    session_id: session_id.clone(),
                    workspace_id: None,
                    workspace_path: cleanup_workspace_path,
                    release_kind: SessionReleaseKind::UnloadPersisted,
                }),
                reservation: Some(SessionTaskReservation::Attaching(session_id)),
                task: restoration,
            });
        drop(connection_state);
        result_rx.await.map_err(|_| {
            RuntimeError::from(PortError::new(
                PortErrorKind::Backend,
                "SDK Host Session restore task ended without a result",
            ))
        })?
    }

    async fn deliver_session_create_response(
        &self,
        request_id: Option<RequestId>,
        created: AgentSessionCreateResult,
        session_id: String,
        lifetime: SessionLifetime,
    ) -> bool {
        let connection = self.clone();
        let (delivered_tx, delivered_rx) = oneshot::channel();
        let mut state = self.inner.state.lock().await;
        if state.shutting_down {
            return false;
        }
        state.publishing_sessions.insert(session_id.clone());
        let publishing_session_id = session_id.clone();
        let delivery = tokio::spawn(async move {
            let delivered = connection
                .send_success(
                    request_id,
                    SessionCreateResult::from_runtime(created, lifetime),
                )
                .await;
            if delivered {
                connection.mark_session_exposed(&session_id).await;
            } else {
                tokio::select! {
                    _ = connection.inner.shutdown_started.cancelled() => {}
                    _ = connection.release_unexposed_session(&session_id) => {}
                }
            }
            let _ = delivered_tx.send(delivered);
        });
        state.pending_session_tasks.push(PendingSessionTask {
            session_cleanup: None,
            reservation: Some(SessionTaskReservation::Publishing(publishing_session_id)),
            task: delivery,
        });
        drop(state);
        delivered_rx.await.unwrap_or(false)
    }

    async fn deliver_query_start_response(
        &self,
        request_id: Option<RequestId>,
        result: QueryStartResult,
        lease: Arc<QueryLease>,
        created_session: bool,
    ) -> bool {
        let connection = self.clone();
        let (delivered_tx, delivered_rx) = oneshot::channel();
        let mut state = self.inner.state.lock().await;
        if state.shutting_down {
            return false;
        }
        let delivery = tokio::spawn(async move {
            let delivered = connection.send_success(request_id, result).await;
            if delivered {
                if created_session {
                    connection.mark_session_exposed(&lease.session_id).await;
                }
            } else {
                let cleanup = async {
                    connection
                        .cancel_and_finish(
                            &lease,
                            QueryResultError::new(
                                ErrorCode::ProcessLost,
                                false,
                                None,
                                &lease.query_id,
                                "SDK Host output is unavailable",
                            ),
                            false,
                        )
                        .await;
                    if created_session {
                        let _ = connection
                            .release_unexposed_session(&lease.session_id)
                            .await;
                    }
                };
                tokio::select! {
                    _ = connection.inner.shutdown_started.cancelled() => {}
                    _ = cleanup => {}
                }
            }
            let _ = delivered_tx.send(delivered);
        });
        state.pending_session_tasks.push(PendingSessionTask {
            session_cleanup: None,
            reservation: None,
            task: delivery,
        });
        drop(state);
        delivered_rx.await.unwrap_or(false)
    }

    async fn reserve_query_session(
        &self,
        session_id: &str,
    ) -> Result<SessionLease, QueryReservationError> {
        let mut state = self.inner.state.lock().await;
        if state.poisoned_sessions.contains(session_id) {
            return Err(QueryReservationError::Poisoned);
        }
        if state.shutting_down
            || state.closing_sessions.contains(session_id)
            || state.starting_query_sessions.contains(session_id)
            || state.active_query_sessions.contains(session_id)
        {
            return Err(QueryReservationError::Unavailable);
        }
        let session = state
            .sessions
            .get(session_id)
            .cloned()
            .ok_or(QueryReservationError::Unavailable)?;
        state.starting_query_sessions.insert(session_id.to_string());
        Ok(session)
    }

    async fn release_query_session(&self, session_id: &str) {
        let mut state = self.inner.state.lock().await;
        state.starting_query_sessions.remove(session_id);
        state.active_query_sessions.remove(session_id);
    }

    async fn mark_session_exposed(&self, session_id: &str) {
        let mut state = self.inner.state.lock().await;
        if let Some(session) = state.sessions.get_mut(session_id) {
            session.exposed = true;
        }
    }

    async fn release_unexposed_session(&self, session_id: &str) -> Result<(), ()> {
        let lease = self
            .inner
            .state
            .lock()
            .await
            .sessions
            .get(session_id)
            .cloned();
        let Some(lease) = lease else {
            return Ok(());
        };
        let release_kind = lease.release_kind();
        match timeout(
            Duration::from_millis(5_000),
            self.release_runtime_session(
                session_id.to_string(),
                lease.workspace_id,
                lease.workspace_path,
                lease.remote_connection_id,
                lease.remote_ssh_host,
                release_kind,
                4_500,
            ),
        )
        .await
        {
            Ok(Ok(_)) => {
                self.inner.state.lock().await.sessions.remove(session_id);
                Ok(())
            }
            Ok(Err(error)) => {
                tracing::warn!(
                    session_id = %session_id,
                    error_kind = runtime_error_kind(&error),
                    "Failed to release an unexposed SDK Host Session"
                );
                self.inner.state.lock().await.cleanup_failed = true;
                Err(())
            }
            Err(_) => {
                tracing::warn!(
                    session_id = %session_id,
                    "Timed out while releasing an unexposed SDK Host Session"
                );
                self.inner.state.lock().await.cleanup_failed = true;
                Err(())
            }
        }
    }

    async fn send_cleanup_required(
        &self,
        request_id: Option<RequestId>,
        stage: ErrorStage,
        session_id: &str,
    ) {
        let message = format!(
            "SDK Host could not remove unexposed Session {session_id}; restart the Host before retrying"
        );
        self.send_error(
            request_id,
            ErrorCode::CleanupRequired,
            stage,
            false,
            Some(RecoveryAction::RestartHost),
            &message,
        )
        .await;
    }

    async fn finish_query(
        &self,
        lease: &Arc<QueryLease>,
        status: QueryTerminalStatus,
        error: Option<QueryResultError>,
        emit_result: bool,
        preserve_host_failure: bool,
    ) {
        if !lease.finish_once() {
            return;
        }
        lease.stop_forwarding.cancel();
        for (_, timeout_cancel) in lease
            .pending_permissions
            .lock()
            .expect("SDK Host pending permission lock poisoned")
            .drain()
        {
            timeout_cancel.cancel();
        }
        let settlement = timeout(
            Duration::from_millis(DEFAULT_TURN_SETTLEMENT_TIMEOUT_MS + 500),
            self.inner
                .runtime
                .wait_for_turn_settlement(AgentTurnSettlementRequest {
                    session_id: lease.session_id.clone(),
                    turn_id: lease.turn_id.clone(),
                    wait_timeout_ms: DEFAULT_TURN_SETTLEMENT_TIMEOUT_MS,
                }),
        )
        .await;
        let settlement_result = match settlement {
            Ok(Ok(result)) => Some(result),
            Ok(Err(_)) | Err(_) => None,
        };
        let settlement_confirmed = settlement_result.is_some();
        {
            let mut state = self.inner.state.lock().await;
            state.queries.remove(&lease.query_id);
            state.starting_query_sessions.remove(&lease.session_id);
            state.active_query_sessions.remove(&lease.session_id);
            if !settlement_confirmed {
                state.poisoned_sessions.insert(lease.session_id.clone());
                state.cleanup_failed = true;
                state.shutting_down = true;
            }
        }
        if !settlement_confirmed {
            lease.stop_forwarding.cancel();
            self.inner.connection_failed.cancel();
            return;
        }
        if emit_result {
            self.send_query_result(
                lease,
                status,
                error,
                settlement_result.expect("confirmed settlement result"),
                preserve_host_failure,
            )
            .await;
        }
    }

    async fn send_query_result(
        &self,
        lease: &QueryLease,
        mut status: QueryTerminalStatus,
        mut error: Option<QueryResultError>,
        settlement: AgentTurnSettlementResult,
        preserve_host_failure: bool,
    ) -> bool {
        if !lease.emit_output {
            return true;
        }
        let mut output_text = settlement.final_response.unwrap_or_default();
        match settlement.status {
            AgentTurnSettlementStatus::Completed if !preserve_host_failure => {
                status = QueryTerminalStatus::Completed;
                error = None;
            }
            AgentTurnSettlementStatus::Completed => {}
            AgentTurnSettlementStatus::Failed => {
                status = QueryTerminalStatus::Failed;
                if error.is_none() {
                    error = Some(QueryResultError::new(
                        ErrorCode::Internal,
                        false,
                        None,
                        &lease.query_id,
                        format!(
                            "Query completed unsuccessfully: {}",
                            settlement.finish_reason.as_deref().unwrap_or("failed")
                        ),
                    ));
                }
            }
            AgentTurnSettlementStatus::Cancelled => {
                if !preserve_host_failure {
                    status = QueryTerminalStatus::Cancelled;
                    error = None;
                }
            }
        }
        if json_string_content_bytes(&output_text) > MAX_QUERY_OUTPUT_WIRE_BYTES {
            output_text.clear();
            status = QueryTerminalStatus::Failed;
            error = Some(QueryResultError::new(
                ErrorCode::Overloaded,
                false,
                None,
                &lease.query_id,
                "SDK Host Query output exceeded the protocol size limit",
            ));
        }
        let structured =
            if lease.structured_output_requested && status == QueryTerminalStatus::Completed {
                match serde_json::from_str(&output_text) {
                    Ok(value) => Some(value),
                    Err(_) => {
                        status = QueryTerminalStatus::Failed;
                        error = Some(QueryResultError::new(
                            ErrorCode::Internal,
                            false,
                            None,
                            &lease.query_id,
                            "Model returned invalid JSON for the requested output schema",
                        ));
                        None
                    }
                }
            } else {
                None
            };
        let usage = lease
            .usage
            .lock()
            .expect("SDK Host Query usage lock poisoned")
            .as_ref()
            .map(|usage| QueryUsage {
                input_tokens: usage.input_tokens,
                output_tokens: usage.output_tokens,
                total_tokens: usage.total_tokens,
                cached_tokens: usage.cached_tokens,
            });
        if let Some(error) = error.as_mut() {
            error.data.operation_id = Some(lease.operation_id.clone());
        }
        self.send_notification(
            NOTIFICATION_QUERY_RESULT,
            QueryResultParams {
                query_id: lease.query_id.clone(),
                session_id: lease.session_id.clone(),
                turn_id: lease.turn_id.clone(),
                operation_id: lease.operation_id.clone(),
                status,
                output: QueryOutput {
                    text: output_text,
                    structured,
                },
                usage,
                error,
            },
        )
        .await
    }

    async fn cancel_and_finish(
        &self,
        lease: &Arc<QueryLease>,
        mut error: QueryResultError,
        emit_result: bool,
    ) {
        let cancellation = timeout(
            Duration::from_millis(2_500),
            self.inner
                .runtime
                .cancel_turn(AgentTurnCancellationRequest {
                    session_id: lease.session_id.clone(),
                    turn_id: Some(lease.turn_id.clone()),
                    source: Some(AgentSubmissionSource::SdkHost),
                    requester_session_id: None,
                    reason: Some("sdk_host_fail_closed".to_string()),
                    wait_timeout_ms: Some(2_000),
                    cancel_descendants: true,
                }),
        )
        .await;
        match cancellation {
            Ok(Ok(_)) => {}
            Ok(Err(cancel_error)) => {
                error = query_error_from_runtime(
                    &lease.query_id,
                    cancel_error,
                    "SDK Host could not cancel the Turn after a Host failure",
                );
            }
            Err(_) => {
                error = QueryResultError::new(
                    ErrorCode::Timeout,
                    true,
                    Some(RecoveryAction::RestartHost),
                    &lease.query_id,
                    "SDK Host cancellation timed out after a Host failure",
                );
            }
        }
        self.finish_query(
            lease,
            QueryTerminalStatus::Failed,
            Some(error),
            emit_result,
            true,
        )
        .await;
    }

    async fn reject_permission_and_finish(
        &self,
        lease: &Arc<QueryLease>,
        request: &PermissionRequest,
    ) {
        let reply = PermissionReply::Reject {
            feedback: Some(
                "Non-interactive SDK execution requires an explicit permission callback"
                    .to_string(),
            ),
        };
        match timeout(
            Duration::from_millis(PERMISSION_REJECTION_TIMEOUT_MS),
            self.inner.runtime.respond_permission_with_source(
                &request.request_id,
                reply,
                PermissionReplySource::System,
            ),
        )
        .await
        {
            Ok(Ok(_)) => {}
            Ok(Err(error)) => {
                self.cancel_and_finish(
                    lease,
                    query_error_from_runtime(
                        &lease.query_id,
                        error,
                        "SDK Host could not reject a pending permission request",
                    ),
                    true,
                )
                .await;
                return;
            }
            Err(_) => {
                self.cancel_and_finish(
                    lease,
                    QueryResultError::new(
                        ErrorCode::Timeout,
                        true,
                        Some(RecoveryAction::RestartHost),
                        &lease.query_id,
                        "SDK Host permission rejection timed out",
                    ),
                    true,
                )
                .await;
                return;
            }
        }
        self.cancel_and_finish(
            lease,
            QueryResultError::new(
                ErrorCode::ActionRequired,
                false,
                None,
                &lease.query_id,
                "Permission approval is required but permission callbacks are unavailable",
            ),
            true,
        )
        .await;
    }

    async fn forward_permission_request(
        &self,
        lease: &Arc<QueryLease>,
        request: &PermissionRequest,
        sequence: &mut u64,
    ) -> bool {
        if !self.inner.state.lock().await.permission_responses {
            self.reject_permission_and_finish(lease, request).await;
            return false;
        }
        let timeout_cancel = {
            let mut pending = lease
                .pending_permissions
                .lock()
                .expect("SDK Host pending permission lock poisoned");
            if pending.contains_key(&request.request_id) {
                return true;
            }
            let timeout_cancel = CancellationToken::new();
            pending.insert(request.request_id.clone(), timeout_cancel.clone());
            timeout_cancel
        };
        *sequence += 1;
        let delivered = self
            .send_notification(
                NOTIFICATION_QUERY_EVENT,
                QueryEventParams {
                    query_id: lease.query_id.clone(),
                    session_id: lease.session_id.clone(),
                    turn_id: lease.turn_id.clone(),
                    operation_id: lease.operation_id.clone(),
                    sequence: *sequence,
                    event: QueryEvent::PermissionRequest {
                        request_id: request.request_id.clone(),
                        action: request.action.clone(),
                        resources: request.resources.clone(),
                        source: PermissionSource {
                            kind: match request.source.kind {
                                PermissionRequestSourceKind::ToolCall => {
                                    PermissionSourceKind::ToolCall
                                }
                                PermissionRequestSourceKind::Provider => {
                                    PermissionSourceKind::Provider
                                }
                                PermissionRequestSourceKind::Extension => {
                                    PermissionSourceKind::Extension
                                }
                            },
                            identity: request.source.identity.clone(),
                        },
                        tool_call_id: request.tool_call_id.clone(),
                        response_timeout_ms: duration_ms(self.inner.permission_response_timeout),
                    },
                },
            )
            .await;
        if !delivered {
            if let Some(timeout_cancel) = lease
                .pending_permissions
                .lock()
                .expect("SDK Host pending permission lock poisoned")
                .remove(&request.request_id)
            {
                timeout_cancel.cancel();
            }
            self.reject_permission_and_finish(lease, request).await;
            return false;
        }
        self.spawn_permission_timeout(lease.clone(), request.request_id.clone(), timeout_cancel);
        true
    }

    fn spawn_permission_timeout(
        &self,
        lease: Arc<QueryLease>,
        request_id: String,
        timeout_cancel: CancellationToken,
    ) {
        let connection = self.clone();
        tokio::spawn(async move {
            tokio::select! {
                _ = lease.stop_forwarding.cancelled() => return,
                _ = timeout_cancel.cancelled() => return,
                _ = tokio::time::sleep(connection.inner.permission_response_timeout) => {}
            }
            let expired = lease
                .pending_permissions
                .lock()
                .expect("SDK Host pending permission lock poisoned")
                .remove(&request_id)
                .is_some();
            if !expired {
                return;
            }
            let rejection = timeout(
                Duration::from_millis(PERMISSION_REJECTION_TIMEOUT_MS),
                connection.inner.runtime.respond_permission_with_source(
                    &request_id,
                    PermissionReply::Reject {
                        feedback: Some("SDK permission response timed out".to_string()),
                    },
                    PermissionReplySource::System,
                ),
            )
            .await;
            match rejection {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    connection
                        .cancel_and_finish(
                            &lease,
                            query_error_from_runtime(
                                &lease.query_id,
                                error,
                                "SDK Host could not reject an expired permission request",
                            ),
                            true,
                        )
                        .await;
                }
                Err(_) => {
                    connection
                        .cancel_and_finish(
                            &lease,
                            QueryResultError::new(
                                ErrorCode::Timeout,
                                true,
                                Some(RecoveryAction::RestartHost),
                                &lease.query_id,
                                "SDK Host permission timeout rejection did not settle",
                            ),
                            true,
                        )
                        .await;
                }
            }
        });
    }

    async fn parse_params<T>(&self, request: &JsonRpcRequest, stage: ErrorStage) -> Option<T>
    where
        T: serde::de::DeserializeOwned,
    {
        match request.params_as() {
            Ok(params) => Some(params),
            Err(_) => {
                self.send_invalid_params(request.id.clone(), stage, "invalid method parameters")
                    .await;
                None
            }
        }
    }

    async fn send_invalid_params(
        &self,
        id: Option<RequestId>,
        stage: ErrorStage,
        message: &'static str,
    ) {
        self.send_rpc_error(
            id,
            -32602,
            ErrorCode::InvalidRequest,
            stage,
            false,
            None,
            OutcomeCertainty::NotStarted,
            None,
            message,
        )
        .await;
    }

    async fn send_runtime_error(
        &self,
        id: Option<RequestId>,
        stage: ErrorStage,
        error: RuntimeError,
    ) {
        let (code, retryable, recovery) = runtime_error_facts(&error);
        self.send_error(id, code, stage, retryable, recovery, &error.into_message())
            .await;
    }

    async fn send_runtime_uncertain_error(
        &self,
        id: Option<RequestId>,
        stage: ErrorStage,
        operation_id: Option<String>,
        error: RuntimeError,
    ) {
        let (code, retryable, recovery) = runtime_error_facts(&error);
        self.send_rpc_error(
            id,
            -32000,
            code,
            stage,
            retryable,
            operation_id,
            OutcomeCertainty::Unknown,
            recovery,
            &error.into_message(),
        )
        .await;
    }

    async fn send_error(
        &self,
        id: Option<RequestId>,
        code: ErrorCode,
        stage: ErrorStage,
        retryable: bool,
        recovery: Option<RecoveryAction>,
        message: &str,
    ) {
        self.send_rpc_error(
            id,
            -32000,
            code,
            stage,
            retryable,
            None,
            OutcomeCertainty::NotStarted,
            recovery,
            message,
        )
        .await;
    }

    async fn send_uncertain_error(
        &self,
        id: Option<RequestId>,
        code: ErrorCode,
        stage: ErrorStage,
        retryable: bool,
        operation_id: Option<String>,
        recovery: Option<RecoveryAction>,
        message: &str,
    ) {
        self.send_rpc_error(
            id,
            -32000,
            code,
            stage,
            retryable,
            operation_id,
            OutcomeCertainty::Unknown,
            recovery,
            message,
        )
        .await;
    }

    #[allow(clippy::too_many_arguments)]
    async fn send_rpc_error(
        &self,
        id: Option<RequestId>,
        rpc_code: i32,
        code: ErrorCode,
        stage: ErrorStage,
        retryable: bool,
        operation_id: Option<String>,
        outcome_certainty: OutcomeCertainty,
        recovery: Option<RecoveryAction>,
        message: &str,
    ) {
        let Some(id) = id else {
            return;
        };
        let correlation_id = id.correlation_id();
        self.send_value(JsonRpcErrorResponse::new(
            id,
            rpc_code,
            message,
            ErrorData {
                code,
                stage,
                retryable,
                correlation_id,
                operation_id,
                causation_id: None,
                outcome_certainty,
                recovery,
            },
        ))
        .await;
    }

    async fn send_success<T: serde::Serialize>(&self, id: Option<RequestId>, result: T) -> bool {
        match id {
            Some(id) => {
                self.send_value(JsonRpcSuccessResponse::new(id, result))
                    .await
            }
            None => true,
        }
    }

    async fn send_notification<T: serde::Serialize>(
        &self,
        method: &'static str,
        params: T,
    ) -> bool {
        self.send_value(JsonRpcNotification::new(method, params))
            .await
    }

    async fn send_value<T: serde::Serialize>(&self, value: T) -> bool {
        let Ok(value) = serde_json::to_value(value) else {
            return false;
        };
        self.inner.output.send(value).await.is_ok()
    }
}

fn event_turn_id(event: &AgenticEvent) -> Option<&str> {
    match event {
        AgenticEvent::DialogTurnCompleted { turn_id, .. }
        | AgenticEvent::DialogTurnCancelled { turn_id, .. }
        | AgenticEvent::DialogTurnFailed { turn_id, .. }
        | AgenticEvent::TokenUsageUpdated { turn_id, .. }
        | AgenticEvent::TextChunk { turn_id, .. }
        | AgenticEvent::ToolEvent { turn_id, .. } => Some(turn_id),
        _ => None,
    }
}

fn is_local_image_path(path: &str) -> bool {
    !path.trim().is_empty()
        && !path.contains("://")
        && local_image_mime_type(Path::new(path)).is_some()
}

fn local_image_attachment(image_path: &str, workspace_path: &str) -> AgentInputAttachment {
    let image_path = PathBuf::from(image_path);
    let image_path = if image_path.is_absolute() {
        image_path
    } else {
        Path::new(workspace_path).join(image_path)
    };
    let mime_type = local_image_mime_type(&image_path).expect("validated local image extension");
    AgentInputAttachment::image_context(
        format!("sdk-image-{}", uuid::Uuid::new_v4()),
        Some(image_path.to_string_lossy().into_owned()),
        None,
        mime_type,
        None,
    )
}

fn local_image_mime_type(path: &Path) -> Option<&'static str> {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("png") => Some("image/png"),
        Some("jpg" | "jpeg") => Some("image/jpeg"),
        Some("gif") => Some("image/gif"),
        Some("webp") => Some("image/webp"),
        _ => None,
    }
}

fn duration_ms(duration: Duration) -> u64 {
    duration.as_millis().min(u64::MAX as u128) as u64
}

fn project_query_event(event: &AgenticEvent) -> Option<QueryEvent> {
    match event {
        AgenticEvent::TextChunk { text, .. } => {
            Some(QueryEvent::AssistantTextDelta { text: text.clone() })
        }
        AgenticEvent::ToolEvent { tool_event, .. } => {
            let (status, progress, duration_ms) = match tool_event {
                ToolEventData::Started { .. } => (ToolEventStatus::Started, None, None),
                ToolEventData::Progress { percentage, .. } => {
                    (ToolEventStatus::Progress, Some(*percentage), None)
                }
                ToolEventData::Completed { duration_ms, .. } => {
                    (ToolEventStatus::Completed, None, Some(*duration_ms))
                }
                ToolEventData::Failed { duration_ms, .. } => {
                    (ToolEventStatus::Failed, None, *duration_ms)
                }
                ToolEventData::Cancelled { duration_ms, .. } => {
                    (ToolEventStatus::Cancelled, None, *duration_ms)
                }
                _ => return None,
            };
            Some(QueryEvent::ToolEvent {
                tool_call_id: tool_event.tool_id().to_string(),
                tool_name: tool_event.effective_tool_name().to_string(),
                status,
                progress,
                duration_ms,
            })
        }
        _ => None,
    }
}

fn terminal_fact(
    event: &AgenticEvent,
    expected_turn_id: &str,
    query_id: &str,
) -> Option<(QueryTerminalStatus, Option<QueryResultError>)> {
    match event {
        AgenticEvent::DialogTurnCompleted {
            turn_id,
            success,
            finish_reason,
            has_final_response,
            ..
        } if turn_id == expected_turn_id => {
            if success == &Some(false) || has_final_response == &Some(false) {
                Some((
                    QueryTerminalStatus::Failed,
                    Some(QueryResultError::new(
                        ErrorCode::Internal,
                        false,
                        None,
                        query_id,
                        format!(
                            "Query completed unsuccessfully: {}",
                            finish_reason
                                .as_deref()
                                .unwrap_or("unsuccessful_completion")
                        ),
                    )),
                ))
            } else {
                Some((QueryTerminalStatus::Completed, None))
            }
        }
        AgenticEvent::DialogTurnCancelled { turn_id, .. } if turn_id == expected_turn_id => {
            Some((QueryTerminalStatus::Cancelled, None))
        }
        AgenticEvent::DialogTurnFailed {
            turn_id,
            error,
            error_category,
            error_detail,
            ..
        } if turn_id == expected_turn_id => Some((
            QueryTerminalStatus::Failed,
            Some(query_error_from_failure(
                query_id,
                error,
                error_category.as_ref(),
                error_detail.as_ref().and_then(|detail| detail.retryable),
            )),
        )),
        _ => None,
    }
}

fn query_error_from_failure(
    correlation_id: &str,
    message: &str,
    category: Option<&ErrorCategory>,
    explicit_retryable: Option<bool>,
) -> QueryResultError {
    let (code, default_retryable, recovery) = match category {
        Some(ErrorCategory::Network | ErrorCategory::ProviderUnavailable) => (
            ErrorCode::ProviderUnavailable,
            true,
            Some(RecoveryAction::Retry),
        ),
        Some(ErrorCategory::Auth) => (ErrorCode::Authentication, false, None),
        Some(ErrorCategory::RateLimit) => {
            (ErrorCode::RateLimited, true, Some(RecoveryAction::Retry))
        }
        Some(ErrorCategory::ContextOverflow) => (ErrorCode::ContextOverflow, false, None),
        Some(ErrorCategory::Timeout) => (ErrorCode::Timeout, true, Some(RecoveryAction::Retry)),
        Some(ErrorCategory::ProviderQuota) => (ErrorCode::ProviderQuota, false, None),
        Some(ErrorCategory::ProviderBilling) => (ErrorCode::ProviderBilling, false, None),
        Some(ErrorCategory::Permission) => (ErrorCode::PermissionDenied, false, None),
        Some(ErrorCategory::InvalidRequest) => (ErrorCode::InvalidRequest, false, None),
        Some(ErrorCategory::ContentPolicy) => (ErrorCode::ContentPolicy, false, None),
        Some(ErrorCategory::ModelError | ErrorCategory::Unknown) | None => {
            (ErrorCode::Internal, false, None)
        }
    };
    QueryResultError::new(
        code,
        explicit_retryable.unwrap_or(default_retryable),
        recovery,
        correlation_id,
        message,
    )
}

fn query_error_from_runtime(
    query_id: &str,
    error: RuntimeError,
    context: &str,
) -> QueryResultError {
    let (code, retryable, recovery) = runtime_error_facts(&error);
    QueryResultError::new(
        code,
        retryable,
        recovery,
        query_id,
        format!("{context}: {}", error.into_message()),
    )
}

fn runtime_error_facts(error: &RuntimeError) -> (ErrorCode, bool, Option<RecoveryAction>) {
    match error {
        RuntimeError::Port(port) => match port.kind {
            PortErrorKind::NotAvailable => (ErrorCode::CapabilityUnavailable, false, None),
            PortErrorKind::NotFound => (ErrorCode::NotFound, false, None),
            PortErrorKind::InvalidRequest => (ErrorCode::InvalidRequest, false, None),
            PortErrorKind::PermissionDenied => (ErrorCode::PermissionDenied, false, None),
            PortErrorKind::Cancelled => (ErrorCode::Cancelled, false, None),
            PortErrorKind::Timeout => (ErrorCode::Timeout, true, Some(RecoveryAction::Retry)),
            PortErrorKind::SessionInUse => {
                (ErrorCode::ActionRequired, true, Some(RecoveryAction::Retry))
            }
            PortErrorKind::CleanupRequired => (
                ErrorCode::CleanupRequired,
                false,
                Some(RecoveryAction::RestartHost),
            ),
            PortErrorKind::OutcomeUnknown => (ErrorCode::ActionRequired, false, None),
            PortErrorKind::Backend => {
                (ErrorCode::Internal, true, Some(RecoveryAction::RestartHost))
            }
        },
        RuntimeError::PermissionRequest(_) => (ErrorCode::PermissionDenied, false, None),
        _ => (ErrorCode::CapabilityUnavailable, false, None),
    }
}

fn permission_request_targets_query(
    request: &PermissionRequest,
    dialog_turn_id: Option<&str>,
    lease: &QueryLease,
) -> bool {
    (request.session_id == lease.session_id && dialog_turn_id == Some(lease.turn_id.as_str()))
        || request.delegation.as_ref().is_some_and(|delegation| {
            delegation.parent_session_id == lease.session_id
                && delegation.parent_dialog_turn_id.as_deref() == Some(lease.turn_id.as_str())
        })
}

fn runtime_error_kind(error: &RuntimeError) -> &'static str {
    match error {
        RuntimeError::Port(port) => match port.kind {
            PortErrorKind::NotAvailable => "not_available",
            PortErrorKind::NotFound => "not_found",
            PortErrorKind::InvalidRequest => "invalid_request",
            PortErrorKind::PermissionDenied => "permission_denied",
            PortErrorKind::Cancelled => "cancelled",
            PortErrorKind::Timeout => "timeout",
            PortErrorKind::SessionInUse => "session_in_use",
            PortErrorKind::CleanupRequired => "cleanup_required",
            PortErrorKind::OutcomeUnknown => "outcome_unknown",
            PortErrorKind::Backend => "backend",
        },
        RuntimeError::MissingDialogTurnPort
        | RuntimeError::MissingLifecycleDeliveryPort
        | RuntimeError::MissingCancellationPort
        | RuntimeError::MissingSessionLineagePort
        | RuntimeError::MissingSessionManagementPort
        | RuntimeError::MissingSessionRestorePort
        | RuntimeError::MissingLocalCommandTurnPort
        | RuntimeError::MissingWorkspaceReferencePort
        | RuntimeError::MissingSessionTranscriptReader
        | RuntimeError::MissingThreadGoalManagementPort
        | RuntimeError::MissingInteractionResponsePort
        | RuntimeError::MissingEventSink
        | RuntimeError::MissingEventSource
        | RuntimeError::MissingPermissionRequestManager => "capability_unavailable",
        RuntimeError::PermissionRequest(_) => "permission_request",
    }
}

#[cfg(test)]
mod runtime_error_tests {
    use super::{
        is_local_image_path, runtime_error_facts, runtime_error_kind, QueryEventBudget,
        QueryOutputAttempt,
    };
    use crate::protocol::{ErrorCode, RecoveryAction};
    use openbitfun_agent_runtime::sdk::{PortError, PortErrorKind, RuntimeError};

    #[test]
    fn local_image_input_accepts_supported_paths_and_rejects_urls() {
        assert!(is_local_image_path("screenshots/failure.PNG"));
        assert!(!is_local_image_path("https://example.com/failure.png"));
        assert!(!is_local_image_path("screenshots/failure.svg"));
        assert!(!is_local_image_path("  "));
    }

    #[test]
    fn structured_event_budget_keeps_only_the_last_model_attempt() {
        let attempt = |round_id: &str| QueryOutputAttempt {
            round_id: round_id.to_string(),
            attempt_id: Some(format!("{round_id}-attempt")),
            attempt_index: Some(0),
        };
        let mut budget = QueryEventBudget::default();

        assert!(budget.observe(r#"{"draft":true}"#, Some(attempt("round-1"))));
        let first_attempt_bytes = budget.wire_bytes;
        assert!(budget.observe(r#"{"final":true}"#, Some(attempt("round-2"))));

        assert_eq!(budget.wire_bytes, first_attempt_bytes);
    }

    #[test]
    fn plain_event_budget_still_aggregates_model_rounds() {
        let mut budget = QueryEventBudget::default();

        assert!(budget.observe("first", None));
        let first_bytes = budget.wire_bytes;
        assert!(budget.observe("second", None));

        assert!(budget.wire_bytes > first_bytes);
    }

    #[test]
    fn session_writer_conflict_uses_existing_action_required_response() {
        let error = RuntimeError::Port(PortError::new(
            PortErrorKind::SessionInUse,
            "Session is already open for writing: session-1",
        ));

        assert_eq!(
            runtime_error_facts(&error),
            (ErrorCode::ActionRequired, true, Some(RecoveryAction::Retry))
        );
        assert_eq!(runtime_error_kind(&error), "session_in_use");
    }

    #[test]
    fn unknown_outcome_requires_an_authoritative_read_before_retry() {
        let error = RuntimeError::Port(PortError::new(
            PortErrorKind::OutcomeUnknown,
            "inspect authoritative state",
        ));

        assert_eq!(
            runtime_error_facts(&error),
            (ErrorCode::ActionRequired, false, None)
        );
        assert_eq!(runtime_error_kind(&error), "outcome_unknown");
    }

    #[test]
    fn missing_workspace_reference_port_uses_capability_unavailable_contract() {
        let error = RuntimeError::MissingWorkspaceReferencePort;

        assert_eq!(
            runtime_error_facts(&error),
            (ErrorCode::CapabilityUnavailable, false, None)
        );
        assert_eq!(runtime_error_kind(&error), "capability_unavailable");
    }

    #[test]
    fn missing_mode_catalog_port_uses_not_available_contract() {
        let error = RuntimeError::Port(PortError::new(
            PortErrorKind::NotAvailable,
            "agent mode catalog port is not registered",
        ));

        assert_eq!(
            runtime_error_facts(&error),
            (ErrorCode::CapabilityUnavailable, false, None)
        );
        assert_eq!(runtime_error_kind(&error), "not_available");
    }
}
