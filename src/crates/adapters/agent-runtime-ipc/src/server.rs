use crate::operation::RuntimeIpcSessionRequirement;
use crate::{
    read_frame, serialize_frame_with_limit, write_frame_with_limit,
    write_serialized_frame_with_limit, DiscoveryRecord, DiscoveryStore, InitializeResult,
    LeaseTransition, LocalIpcEndpoint, LocalIpcListener, LocalIpcStream, RuntimeInstanceIdentity,
    RuntimeInstanceLock, RuntimeIpcCapabilities, RuntimeIpcDiscoveryError, RuntimeIpcError,
    RuntimeIpcErrorCode, RuntimeIpcEvent, RuntimeIpcFrame, RuntimeIpcFrameReader,
    RuntimeIpcIoError, RuntimeIpcOperation, RuntimeIpcOperationResult, RuntimeIpcRequestHandler,
    RuntimeIpcTransportError, RuntimeSessionLeases, MAX_REQUEST_FRAME_BYTES,
    MAX_RESPONSE_FRAME_BYTES, PROTOCOL_VERSION,
};
use openbitfun_events::AgenticEvent;
use openbitfun_runtime_ports::{AgentSubmissionSource, AgentTurnCancellationRequest};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{broadcast, watch};
use tokio::task::JoinSet;
use uuid::Uuid;

const MAX_CONNECTION_LIMIT: usize = 1024;

#[derive(Debug, Clone)]
pub struct RuntimeIpcServerConfig {
    pub server_version: String,
    pub idle_timeout: Duration,
    pub handshake_timeout: Duration,
    pub request_timeout: Duration,
    pub max_connections: usize,
}

pub struct RuntimeIpcServer {
    listener: LocalIpcListener,
    #[cfg(test)]
    endpoint: LocalIpcEndpoint,
    discovery_store: DiscoveryStore,
    discovery_record: DiscoveryRecord,
    _instance_lock: RuntimeInstanceLock,
    connection: Arc<ConnectionConfig>,
    idle_timeout: Duration,
    max_connections: usize,
}

impl RuntimeIpcServer {
    pub async fn bind(
        runtime_root: &Path,
        identity: RuntimeInstanceIdentity,
        config: RuntimeIpcServerConfig,
    ) -> Result<Self, RuntimeIpcServerError> {
        Self::bind_inner(runtime_root, identity, config, None).await
    }

    pub async fn bind_with_handler(
        runtime_root: &Path,
        identity: RuntimeInstanceIdentity,
        config: RuntimeIpcServerConfig,
        handler: Arc<dyn RuntimeIpcRequestHandler>,
    ) -> Result<Self, RuntimeIpcServerError> {
        Self::bind_inner(runtime_root, identity, config, Some(handler)).await
    }

    async fn bind_inner(
        runtime_root: &Path,
        identity: RuntimeInstanceIdentity,
        config: RuntimeIpcServerConfig,
        handler: Option<Arc<dyn RuntimeIpcRequestHandler>>,
    ) -> Result<Self, RuntimeIpcServerError> {
        validate_server_config(&config)?;
        let instance_lock = RuntimeInstanceLock::try_acquire(runtime_root, &identity)?;
        let owner_id = Uuid::new_v4().simple().to_string();
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let endpoint = LocalIpcEndpoint::for_instance(runtime_root, &identity)?;
        let listener = LocalIpcListener::bind(endpoint.clone()).await?;
        let discovery_store = DiscoveryStore::new(runtime_root, identity.clone());
        let discovery_record = DiscoveryRecord::new(
            identity.clone(),
            endpoint.discovery_value().to_string(),
            std::process::id(),
            token.clone(),
            owner_id,
        );
        discovery_store.write(&discovery_record)?;

        Ok(Self {
            listener,
            #[cfg(test)]
            endpoint,
            discovery_store,
            discovery_record,
            _instance_lock: instance_lock,
            connection: Arc::new(ConnectionConfig {
                instance_identity: identity.as_str().to_string(),
                token,
                server_version: config.server_version,
                handshake_timeout: config.handshake_timeout,
                request_timeout: config.request_timeout,
                handler,
                leases: Arc::new(RuntimeSessionLeases::default()),
                attachment_gate: Arc::new(tokio::sync::Mutex::new(())),
            }),
            idle_timeout: config.idle_timeout,
            max_connections: config.max_connections,
        })
    }

    pub fn discovery_record(&self) -> &DiscoveryRecord {
        &self.discovery_record
    }

    #[cfg(test)]
    pub(crate) fn endpoint(&self) -> &LocalIpcEndpoint {
        &self.endpoint
    }

    pub async fn serve(mut self) -> Result<(), RuntimeIpcServerError> {
        let result = self.serve_until_idle().await;
        let cleanup = self
            .discovery_store
            .remove_if_owned(&self.discovery_record)
            .map(|_| ())
            .map_err(RuntimeIpcServerError::Discovery);
        result.and(cleanup)
    }

    async fn serve_until_idle(&mut self) -> Result<(), RuntimeIpcServerError> {
        let mut clients = JoinSet::new();
        loop {
            if clients.is_empty() {
                tokio::select! {
                    accepted = self.listener.accept() => {
                        let stream = accepted?;
                        spawn_connection(&mut clients, stream, self.connection.clone());
                    }
                    _ = tokio::time::sleep(self.idle_timeout) => break,
                }
            } else if clients.len() >= self.max_connections {
                observe_connection(clients.join_next().await)?;
            } else {
                tokio::select! {
                    accepted = self.listener.accept() => {
                        let stream = accepted?;
                        spawn_connection(&mut clients, stream, self.connection.clone());
                    }
                    completed = clients.join_next() => {
                        observe_connection(completed)?;
                    }
                }
            }
        }
        Ok(())
    }
}

impl Drop for RuntimeIpcServer {
    fn drop(&mut self) {
        let _ = self.discovery_store.remove_if_owned(&self.discovery_record);
    }
}

fn spawn_connection(
    clients: &mut JoinSet<Result<(), RuntimeIpcServerError>>,
    stream: LocalIpcStream,
    config: Arc<ConnectionConfig>,
) {
    clients.spawn(async move { handle_connection(stream, &config).await });
}

fn observe_connection(
    completed: Option<Result<Result<(), RuntimeIpcServerError>, tokio::task::JoinError>>,
) -> Result<(), RuntimeIpcServerError> {
    match completed {
        Some(Ok(Ok(()))) | Some(Ok(Err(_))) => Ok(()),
        Some(Err(error)) => Err(RuntimeIpcServerError::ConnectionTask(error)),
        None => Ok(()),
    }
}

struct ConnectionConfig {
    instance_identity: String,
    token: String,
    server_version: String,
    handshake_timeout: Duration,
    request_timeout: Duration,
    handler: Option<Arc<dyn RuntimeIpcRequestHandler>>,
    leases: Arc<RuntimeSessionLeases>,
    attachment_gate: Arc<tokio::sync::Mutex<()>>,
}

async fn handle_connection(
    mut stream: LocalIpcStream,
    config: &ConnectionConfig,
) -> Result<(), RuntimeIpcServerError> {
    let connection_id = Uuid::new_v4().simple().to_string();
    let first = match timeout_read(config.handshake_timeout, &mut stream).await {
        Ok(frame) => frame,
        Err(RuntimeIpcServerError::Disconnected) => return Ok(()),
        Err(error) => return Err(error),
    };
    let (request_id, request) = match first {
        RuntimeIpcFrame::Initialize {
            request_id,
            request,
        } => (request_id, request),
        frame => {
            send_error(
                &mut stream,
                config.handshake_timeout,
                request_id_of(&frame),
                RuntimeIpcErrorCode::InvalidRequest,
                "initialize must be the first frame",
            )
            .await?;
            return Ok(());
        }
    };

    if !constant_time_eq(request.token.as_bytes(), config.token.as_bytes()) {
        send_error(
            &mut stream,
            config.handshake_timeout,
            Some(request_id),
            RuntimeIpcErrorCode::Unauthorized,
            "runtime IPC authentication failed",
        )
        .await?;
        return Ok(());
    }
    if request.protocol_version != PROTOCOL_VERSION {
        send_error(
            &mut stream,
            config.handshake_timeout,
            Some(request_id),
            RuntimeIpcErrorCode::IncompatibleProtocol,
            "runtime IPC protocol version is incompatible",
        )
        .await?;
        return Ok(());
    }
    if request.instance_identity != config.instance_identity {
        send_error(
            &mut stream,
            config.handshake_timeout,
            Some(request_id),
            RuntimeIpcErrorCode::WrongInstance,
            "runtime IPC endpoint belongs to another instance",
        )
        .await?;
        return Ok(());
    }
    if !valid_client_fact(&request.client_id) || !valid_client_fact(&request.client_version) {
        send_error(
            &mut stream,
            config.handshake_timeout,
            Some(request_id),
            RuntimeIpcErrorCode::InvalidRequest,
            "runtime IPC client identity is invalid",
        )
        .await?;
        return Ok(());
    }

    let interactive_tui = config
        .handler
        .as_ref()
        .is_some_and(|handler| handler.ensure_available().is_ok());
    timeout_write(
        config.handshake_timeout,
        &mut stream,
        &RuntimeIpcFrame::Initialized {
            request_id,
            result: InitializeResult {
                protocol_version: PROTOCOL_VERSION,
                instance_identity: config.instance_identity.clone(),
                server_version: config.server_version.clone(),
                capabilities: RuntimeIpcCapabilities {
                    workspace_id_references: true,
                    health: true,
                    interactive_tui,
                },
            },
        },
    )
    .await?;

    let mut events = None;
    let mut availability = config
        .handler
        .as_ref()
        .and_then(|handler| handler.subscribe_availability());
    let mut active_turn_id = None;
    let result = run_initialized_connection(
        &mut stream,
        config,
        &connection_id,
        &mut events,
        &mut availability,
        &mut active_turn_id,
    )
    .await;
    cleanup_connection(config, &connection_id, active_turn_id, events.as_mut()).await;
    match result {
        Err(RuntimeIpcServerError::Disconnected) => Ok(()),
        other => other,
    }
}

async fn run_initialized_connection(
    stream: &mut LocalIpcStream,
    config: &ConnectionConfig,
    connection_id: &str,
    events: &mut Option<broadcast::Receiver<RuntimeIpcEvent>>,
    availability: &mut Option<watch::Receiver<bool>>,
    active_turn_id: &mut Option<String>,
) -> Result<(), RuntimeIpcServerError> {
    let mut frames = RuntimeIpcFrameReader::new(MAX_REQUEST_FRAME_BYTES);
    let mut frame_deadline = None;
    let mut interruptible_lineage_reads = JoinSet::new();
    let mut interruptible_lineage_request_id = None;
    loop {
        match next_connection_input(
            config.request_timeout,
            stream,
            &mut frames,
            &mut frame_deadline,
            events.as_mut(),
            availability.as_mut(),
            &mut interruptible_lineage_reads,
        )
        .await?
        {
            ConnectionInput::InterruptibleLineageReadCompleted(completed) => {
                let Some(request_id) = interruptible_lineage_request_id.take() else {
                    continue;
                };
                match completed {
                    Ok(InterruptibleLineageReadResult::Completed(result)) => match result {
                        Ok(result) => {
                            send_operation_result(
                                config.request_timeout,
                                stream,
                                request_id,
                                result,
                            )
                            .await?;
                        }
                        Err(error) => {
                            send_runtime_error(
                                stream,
                                config.request_timeout,
                                Some(request_id),
                                error,
                            )
                            .await?;
                        }
                    },
                    Ok(InterruptibleLineageReadResult::Deadline) => {
                        send_error(
                            stream,
                            config.request_timeout,
                            Some(request_id),
                            RuntimeIpcErrorCode::Unavailable,
                            "runtime lineage read exceeded its deadline",
                        )
                        .await?;
                    }
                    Err(error) => {
                        send_error(
                            stream,
                            config.request_timeout,
                            Some(request_id),
                            RuntimeIpcErrorCode::Internal,
                            &format!("runtime lineage read task stopped: {error}"),
                        )
                        .await?;
                    }
                }
            }
            ConnectionInput::Event(event) => {
                if matches!(event, RuntimeIpcEvent::StreamInvalidated { .. }) {
                    timeout_write(
                        config.request_timeout,
                        stream,
                        &RuntimeIpcFrame::Event { event },
                    )
                    .await?;
                    return Err(RuntimeIpcServerError::EventStreamUnavailable);
                }
                let Some(attached) = config.leases.attached_session(connection_id) else {
                    continue;
                };
                if event.session_id() != Some(attached.as_str()) {
                    continue;
                }
                if event_finishes_turn(&event, active_turn_id.as_deref()) {
                    *active_turn_id = None;
                }
                let frame = RuntimeIpcFrame::Event { event };
                let frame_bytes = match serialize_frame_with_limit(&frame, MAX_RESPONSE_FRAME_BYTES)
                {
                    Ok(bytes) => bytes,
                    Err(RuntimeIpcIoError::FrameTooLarge { .. }) => {
                        timeout_write(
                            config.request_timeout,
                            stream,
                            &RuntimeIpcFrame::Event {
                                event: RuntimeIpcEvent::StreamInvalidated {
                                    reason:
                                        crate::RuntimeIpcStreamInvalidationReason::FrameTooLarge,
                                },
                            },
                        )
                        .await?;
                        return Err(RuntimeIpcServerError::EventStreamUnavailable);
                    }
                    Err(error) => return Err(RuntimeIpcServerError::Io(error)),
                };
                timeout_write_serialized(config.request_timeout, stream, &frame_bytes).await?;
            }
            ConnectionInput::EventLagged => {
                return Err(RuntimeIpcServerError::EventStreamUnavailable)
            }
            ConnectionInput::EventClosed => {
                return Err(RuntimeIpcServerError::EventStreamUnavailable)
            }
            ConnectionInput::RuntimeUnavailable => {
                return Err(RuntimeIpcServerError::EventStreamUnavailable)
            }
            ConnectionInput::Frame(RuntimeIpcFrame::Request {
                request_id,
                operation,
            }) => {
                if let Some(superseded_request_id) = interruptible_lineage_request_id.take() {
                    interruptible_lineage_reads.abort_all();
                    while interruptible_lineage_reads.join_next().await.is_some() {}
                    send_error(
                        stream,
                        config.request_timeout,
                        Some(superseded_request_id),
                        RuntimeIpcErrorCode::Unavailable,
                        "runtime lineage read was superseded by a newer request",
                    )
                    .await?;
                }
                if matches!(operation, RuntimeIpcOperation::Health) {
                    send_operation_result(
                        config.request_timeout,
                        stream,
                        request_id,
                        RuntimeIpcOperationResult::Health {
                            instance_identity: config.instance_identity.clone(),
                            process_id: std::process::id(),
                        },
                    )
                    .await?;
                    continue;
                }
                let Some(handler) = config.handler.as_ref() else {
                    send_runtime_error(
                        stream,
                        config.request_timeout,
                        Some(request_id),
                        RuntimeIpcError {
                            code: RuntimeIpcErrorCode::OperationUnsupported,
                            message:
                                "runtime IPC server does not provide interactive TUI operations"
                                    .to_string(),
                        },
                    )
                    .await?;
                    continue;
                };
                if let Err(error) = handler.ensure_available() {
                    send_runtime_error(stream, config.request_timeout, Some(request_id), error)
                        .await?;
                    continue;
                }

                let rules = operation.rules();
                if active_turn_id.is_some() && rules.requires_idle {
                    send_error(
                        stream,
                        config.request_timeout,
                        Some(request_id),
                        RuntimeIpcErrorCode::SessionInUse,
                        "finish or cancel the active turn before starting this session operation",
                    )
                    .await?;
                    continue;
                }
                if let RuntimeIpcOperation::SteerTurn { request } = &operation {
                    if active_turn_id.as_deref() != Some(request.turn_id.as_str()) {
                        send_error(
                            stream,
                            config.request_timeout,
                            Some(request_id),
                            RuntimeIpcErrorCode::SessionInUse,
                            "steering requires the connection's exact active turn",
                        )
                        .await?;
                        continue;
                    }
                }

                // Serialize attachment so a newly visible Session cannot be claimed
                // before its generated ID returns to the creating connection, or
                // deleted while another connection is attaching it.
                let _attachment_guard = if rules.serializes_session_selection {
                    Some(config.attachment_gate.lock().await)
                } else {
                    None
                };
                let mut lease_transition =
                    match prepare_operation(config, connection_id, &operation) {
                        Ok(transition) => transition,
                        Err(error) => {
                            send_runtime_error(
                                stream,
                                config.request_timeout,
                                Some(request_id),
                                error,
                            )
                            .await?;
                            continue;
                        }
                    };
                if operation.is_interruptible_lineage_read() {
                    let handler = handler.clone();
                    let request_timeout = config.request_timeout;
                    interruptible_lineage_reads.spawn(async move {
                        match tokio::time::timeout(request_timeout, handler.execute(operation))
                            .await
                        {
                            Ok(result) => InterruptibleLineageReadResult::Completed(result),
                            Err(_) => InterruptibleLineageReadResult::Deadline,
                        }
                    });
                    interruptible_lineage_request_id = Some(request_id);
                    continue;
                }
                let provisional_turn_id = match &operation {
                    RuntimeIpcOperation::SubmitTurn { request } => {
                        let Some(turn_id) = request.turn_id.clone() else {
                            send_error(
                                stream,
                                config.request_timeout,
                                Some(request_id),
                                RuntimeIpcErrorCode::InvalidRequest,
                                "Shared TUI submit requires a stable turn id",
                            )
                            .await?;
                            continue;
                        };
                        *active_turn_id = Some(turn_id.clone());
                        Some(turn_id)
                    }
                    RuntimeIpcOperation::RunUserShellCommand { request } => {
                        let turn_id = request.turn_id.clone();
                        *active_turn_id = Some(turn_id.clone());
                        Some(turn_id)
                    }
                    RuntimeIpcOperation::CompactSession { request } => {
                        let turn_id = request.turn_id.clone();
                        *active_turn_id = Some(turn_id.clone());
                        Some(turn_id)
                    }
                    _ => None,
                };
                let steering_target = match &operation {
                    RuntimeIpcOperation::SteerTurn { request } => {
                        Some((request.session_id.clone(), request.turn_id.clone()))
                    }
                    _ => None,
                };
                let side_effecting = rules.side_effecting;
                let result =
                    tokio::time::timeout(config.request_timeout, handler.execute(operation)).await;
                let result = match result {
                    Ok(Ok(result)) => result,
                    Ok(Err(error)) => {
                        if provisional_turn_id.is_some() {
                            *active_turn_id = None;
                        }
                        config
                            .leases
                            .rollback(connection_id, lease_transition.clone());
                        send_runtime_error(stream, config.request_timeout, Some(request_id), error)
                            .await?;
                        continue;
                    }
                    Err(_) if provisional_turn_id.is_some() => {
                        send_error(
                            stream,
                            config.request_timeout,
                            Some(request_id),
                            RuntimeIpcErrorCode::OutcomeUnknown,
                            "turn submission outcome is unknown; the connection will close and cancel the submitted turn id",
                        )
                        .await?;
                        return Err(RuntimeIpcServerError::Disconnected);
                    }
                    Err(_) if side_effecting => {
                        config
                            .leases
                            .rollback(connection_id, lease_transition.clone());
                        send_error(
                            stream,
                            config.request_timeout,
                            Some(request_id),
                            RuntimeIpcErrorCode::OutcomeUnknown,
                            "runtime operation outcome is unknown; inspect authoritative state before retrying",
                        )
                        .await?;
                        return Err(RuntimeIpcServerError::Disconnected);
                    }
                    Err(_) => {
                        config
                            .leases
                            .rollback(connection_id, lease_transition.clone());
                        send_error(
                            stream,
                            config.request_timeout,
                            Some(request_id),
                            RuntimeIpcErrorCode::Unavailable,
                            "runtime IPC operation exceeded its deadline",
                        )
                        .await?;
                        continue;
                    }
                };
                if matches!(result, RuntimeIpcOperationResult::SessionReverted { .. }) {
                    // Core has cancelled and drained the owned turn before applying
                    // the revert, so the connection must drop its provisional view.
                    *active_turn_id = None;
                }
                let response = RuntimeIpcFrame::Response { request_id, result };
                let revert_response = matches!(
                    &response,
                    RuntimeIpcFrame::Response {
                        result: RuntimeIpcOperationResult::SessionReverted { .. },
                        ..
                    }
                );
                let response_bytes = match serialize_frame_with_limit(
                    &response,
                    MAX_RESPONSE_FRAME_BYTES,
                ) {
                    Err(RuntimeIpcIoError::FrameTooLarge { .. }) if revert_response => {
                        config.leases.rollback(connection_id, lease_transition);
                        send_error(
                                stream,
                                config.request_timeout,
                                Some(request_id),
                                RuntimeIpcErrorCode::OutcomeUnknown,
                                "session revert completed but its authoritative transcript exceeds the Shared TUI response limit; reconnect and restore the Session",
                            )
                            .await?;
                        return Err(RuntimeIpcServerError::Disconnected);
                    }
                    Err(RuntimeIpcIoError::FrameTooLarge { .. }) => {
                        config.leases.rollback(connection_id, lease_transition);
                        send_error(
                            stream,
                            config.request_timeout,
                            Some(request_id),
                            RuntimeIpcErrorCode::FrameTooLarge,
                            "runtime IPC response exceeds the supported frame size",
                        )
                        .await?;
                        continue;
                    }
                    Err(error) => return Err(RuntimeIpcServerError::Io(error)),
                    Ok(bytes) => bytes,
                };

                let RuntimeIpcFrame::Response { result, .. } = &response else {
                    unreachable!("response frame was just constructed")
                };
                let created_session_id = match result {
                    RuntimeIpcOperationResult::SessionCreated { session } => {
                        Some(session.session_id.as_str())
                    }
                    RuntimeIpcOperationResult::SessionForked { session, .. } => {
                        Some(session.session_id.as_str())
                    }
                    _ => None,
                };
                if let Some(created_session_id) = created_session_id {
                    lease_transition = match config.leases.switch(connection_id, created_session_id)
                    {
                        Ok(transition) => transition,
                        Err(error) => {
                            send_runtime_error(
                                stream,
                                config.request_timeout,
                                Some(request_id),
                                error,
                            )
                            .await?;
                            continue;
                        }
                    };
                }
                let mut event_stream_unavailable = false;
                if let Some(session_id) = match result {
                    RuntimeIpcOperationResult::SessionCreated { session } => {
                        Some(session.session_id.as_str())
                    }
                    RuntimeIpcOperationResult::SessionRestored { session, .. } => {
                        Some(session.session_id.as_str())
                    }
                    RuntimeIpcOperationResult::SessionForked { session, .. } => {
                        Some(session.session_id.as_str())
                    }
                    _ => None,
                } {
                    match handler.subscribe_events(session_id) {
                        Ok(receiver) => *events = Some(receiver),
                        Err(_) => event_stream_unavailable = true,
                    }
                }
                if let RuntimeIpcOperationResult::TurnAccepted { turn_id, .. } = result {
                    if provisional_turn_id.as_deref() != Some(turn_id.as_str()) {
                        send_error(
                            stream,
                            config.request_timeout,
                            Some(request_id),
                            RuntimeIpcErrorCode::Internal,
                            "runtime returned a different turn id than the accepted turn operation",
                        )
                        .await?;
                        return Err(RuntimeIpcServerError::Disconnected);
                    }
                }
                if let Some((expected_session_id, expected_turn_id)) = steering_target.as_ref() {
                    let identity_matches = matches!(
                        result,
                        RuntimeIpcOperationResult::TurnSteered {
                            session_id,
                            turn_id,
                            ..
                        } if session_id == expected_session_id && turn_id == expected_turn_id
                    );
                    if !identity_matches {
                        send_error(
                            stream,
                            config.request_timeout,
                            Some(request_id),
                            RuntimeIpcErrorCode::Internal,
                            "runtime returned an invalid result for the steering operation",
                        )
                        .await?;
                        return Err(RuntimeIpcServerError::Disconnected);
                    }
                }
                if let Err(error) =
                    timeout_write_serialized(config.request_timeout, stream, &response_bytes).await
                {
                    config.leases.rollback(connection_id, lease_transition);
                    return Err(error);
                }
                if event_stream_unavailable {
                    return Err(RuntimeIpcServerError::EventStreamUnavailable);
                }
            }
            ConnectionInput::Frame(frame) => {
                send_error(
                    stream,
                    config.request_timeout,
                    request_id_of(&frame),
                    RuntimeIpcErrorCode::InvalidRequest,
                    "runtime IPC frame is not valid after initialization",
                )
                .await?;
                return Ok(());
            }
        }
    }
}

enum ConnectionInput {
    Frame(RuntimeIpcFrame),
    Event(RuntimeIpcEvent),
    EventLagged,
    EventClosed,
    RuntimeUnavailable,
    InterruptibleLineageReadCompleted(
        Result<InterruptibleLineageReadResult, tokio::task::JoinError>,
    ),
}

enum InterruptibleLineageReadResult {
    Completed(Result<RuntimeIpcOperationResult, RuntimeIpcError>),
    Deadline,
}

async fn next_connection_input(
    timeout: Duration,
    stream: &mut LocalIpcStream,
    frames: &mut RuntimeIpcFrameReader,
    frame_deadline: &mut Option<tokio::time::Instant>,
    events: Option<&mut broadcast::Receiver<RuntimeIpcEvent>>,
    availability: Option<&mut watch::Receiver<bool>>,
    interruptible_lineage_reads: &mut JoinSet<InterruptibleLineageReadResult>,
) -> Result<ConnectionInput, RuntimeIpcServerError> {
    tokio::select! {
        frame = read_connected(timeout, stream, frames, frame_deadline) => frame.map(ConnectionInput::Frame),
        completed = receive_interruptible_lineage_read(interruptible_lineage_reads) => {
            Ok(ConnectionInput::InterruptibleLineageReadCompleted(completed))
        },
        event = receive_event(events) => match event {
            None => std::future::pending().await,
            Some(Ok(event)) => Ok(ConnectionInput::Event(event)),
            Some(Err(broadcast::error::RecvError::Lagged(_))) => Ok(ConnectionInput::EventLagged),
            Some(Err(broadcast::error::RecvError::Closed)) => Ok(ConnectionInput::EventClosed),
        },
        () = wait_until_unavailable(availability) => Ok(ConnectionInput::RuntimeUnavailable),
    }
}

async fn receive_interruptible_lineage_read(
    reads: &mut JoinSet<InterruptibleLineageReadResult>,
) -> Result<InterruptibleLineageReadResult, tokio::task::JoinError> {
    if reads.is_empty() {
        return std::future::pending().await;
    }
    reads
        .join_next()
        .await
        .expect("a non-empty lineage read set should yield a task")
}

async fn receive_event(
    events: Option<&mut broadcast::Receiver<RuntimeIpcEvent>>,
) -> Option<Result<RuntimeIpcEvent, broadcast::error::RecvError>> {
    match events {
        Some(events) => Some(events.recv().await),
        None => std::future::pending().await,
    }
}

async fn wait_until_unavailable(availability: Option<&mut watch::Receiver<bool>>) {
    let Some(availability) = availability else {
        return std::future::pending().await;
    };
    while *availability.borrow() {
        if availability.changed().await.is_err() {
            break;
        }
    }
}

fn prepare_operation(
    config: &ConnectionConfig,
    connection_id: &str,
    operation: &RuntimeIpcOperation,
) -> Result<LeaseTransition, RuntimeIpcError> {
    let session_id = operation.session_id();
    match operation.rules().session_requirement {
        RuntimeIpcSessionRequirement::None => {}
        RuntimeIpcSessionRequirement::CurrentController => config.leases.validate(
            connection_id,
            session_id.expect("controller operations are session scoped"),
        )?,
        RuntimeIpcSessionRequirement::AttachExisting => {
            return config.leases.switch(
                connection_id,
                session_id.expect("attachment operations are session scoped"),
            );
        }
        RuntimeIpcSessionRequirement::UncontrolledTarget => config.leases.validate_uncontrolled(
            session_id.expect("uncontrolled-target operations are session scoped"),
        )?,
    }
    Ok(LeaseTransition::Unchanged)
}

async fn cleanup_connection(
    config: &ConnectionConfig,
    connection_id: &str,
    active_turn_id: Option<String>,
    events: Option<&mut broadcast::Receiver<RuntimeIpcEvent>>,
) {
    let session_id = config.leases.attached_session(connection_id);
    let mut release_lease = true;
    if let (Some(handler), Some(session_id), Some(turn_id)) =
        (config.handler.as_ref(), session_id.as_ref(), active_turn_id)
    {
        let cancellation = handler.execute(RuntimeIpcOperation::CancelTurn {
            request: AgentTurnCancellationRequest {
                session_id: session_id.clone(),
                turn_id: Some(turn_id.clone()),
                source: Some(AgentSubmissionSource::Cli),
                requester_session_id: None,
                reason: Some("shared_tui_disconnected".to_string()),
                wait_timeout_ms: None,
                cancel_descendants: true,
            },
        });
        let cancelled = matches!(
            tokio::time::timeout(config.request_timeout, cancellation).await,
            Ok(Ok(RuntimeIpcOperationResult::TurnCancelled { .. }))
        );
        release_lease =
            cancelled && wait_for_turn_terminal(config.request_timeout, events, &turn_id).await;
    }
    if release_lease {
        config.leases.release_connection(connection_id);
    }
}

async fn wait_for_turn_terminal(
    timeout: Duration,
    events: Option<&mut broadcast::Receiver<RuntimeIpcEvent>>,
    turn_id: &str,
) -> bool {
    let Some(events) = events else { return false };
    tokio::time::timeout(timeout, async {
        loop {
            match events.recv().await {
                Ok(RuntimeIpcEvent::StreamInvalidated { .. }) => return false,
                Ok(event) if event_finishes_turn(&event, Some(turn_id)) => return true,
                Ok(_) => {}
                Err(_) => return false,
            }
        }
    })
    .await
    .unwrap_or(false)
}

fn event_finishes_turn(event: &RuntimeIpcEvent, active_turn_id: Option<&str>) -> bool {
    let (RuntimeIpcEvent::Agent { envelope, .. }, Some(active_turn_id)) = (event, active_turn_id)
    else {
        return false;
    };
    matches!(
        &envelope.event,
        AgenticEvent::DialogTurnCompleted { turn_id, .. }
            | AgenticEvent::DialogTurnCancelled { turn_id, .. }
            | AgenticEvent::DialogTurnFailed { turn_id, .. }
            if turn_id == active_turn_id
    )
}

async fn read_connected(
    timeout: Duration,
    stream: &mut LocalIpcStream,
    frames: &mut RuntimeIpcFrameReader,
    frame_deadline: &mut Option<tokio::time::Instant>,
) -> Result<RuntimeIpcFrame, RuntimeIpcServerError> {
    if !frames.frame_started() {
        map_connected_read(frames.wait_for_frame_start(stream).await)?;
        *frame_deadline = Some(tokio::time::Instant::now() + timeout);
    }
    let deadline = *frame_deadline.get_or_insert_with(|| tokio::time::Instant::now() + timeout);
    match tokio::time::timeout_at(deadline, frames.read_strict(stream)).await {
        Err(_) => Err(RuntimeIpcServerError::IoTimeout),
        Ok(result) => {
            *frame_deadline = None;
            map_connected_read(result)
        }
    }
}

fn map_connected_read<T>(result: Result<T, RuntimeIpcIoError>) -> Result<T, RuntimeIpcServerError> {
    match result {
        Err(RuntimeIpcIoError::Io(error))
            if matches!(
                error.kind(),
                std::io::ErrorKind::UnexpectedEof
                    | std::io::ErrorKind::BrokenPipe
                    | std::io::ErrorKind::ConnectionReset
            ) =>
        {
            Err(RuntimeIpcServerError::Disconnected)
        }
        Err(error) => Err(RuntimeIpcServerError::Io(error)),
        Ok(frame) => Ok(frame),
    }
}

async fn timeout_read(
    timeout: Duration,
    stream: &mut LocalIpcStream,
) -> Result<RuntimeIpcFrame, RuntimeIpcServerError> {
    match tokio::time::timeout(timeout, read_frame(stream)).await {
        Err(_) => Err(RuntimeIpcServerError::IoTimeout),
        Ok(Err(RuntimeIpcIoError::Io(error)))
            if matches!(
                error.kind(),
                std::io::ErrorKind::UnexpectedEof
                    | std::io::ErrorKind::BrokenPipe
                    | std::io::ErrorKind::ConnectionReset
            ) =>
        {
            Err(RuntimeIpcServerError::Disconnected)
        }
        Ok(Err(error)) => Err(RuntimeIpcServerError::Io(error)),
        Ok(Ok(frame)) => Ok(frame),
    }
}

async fn timeout_write(
    timeout: Duration,
    stream: &mut LocalIpcStream,
    frame: &RuntimeIpcFrame,
) -> Result<(), RuntimeIpcServerError> {
    tokio::time::timeout(
        timeout,
        write_frame_with_limit(stream, frame, MAX_RESPONSE_FRAME_BYTES),
    )
    .await
    .map_err(|_| RuntimeIpcServerError::IoTimeout)?
    .map_err(RuntimeIpcServerError::Io)
}

async fn timeout_write_serialized(
    timeout: Duration,
    stream: &mut LocalIpcStream,
    bytes: &[u8],
) -> Result<(), RuntimeIpcServerError> {
    tokio::time::timeout(
        timeout,
        write_serialized_frame_with_limit(stream, bytes, MAX_RESPONSE_FRAME_BYTES),
    )
    .await
    .map_err(|_| RuntimeIpcServerError::IoTimeout)?
    .map_err(RuntimeIpcServerError::Io)
}

async fn send_error(
    stream: &mut LocalIpcStream,
    timeout: Duration,
    request_id: Option<u64>,
    code: RuntimeIpcErrorCode,
    message: &str,
) -> Result<(), RuntimeIpcServerError> {
    timeout_write(
        timeout,
        stream,
        &RuntimeIpcFrame::Error {
            request_id,
            error: RuntimeIpcError {
                code,
                message: message.to_string(),
            },
        },
    )
    .await
}

async fn send_operation_result(
    timeout: Duration,
    stream: &mut LocalIpcStream,
    request_id: u64,
    result: RuntimeIpcOperationResult,
) -> Result<(), RuntimeIpcServerError> {
    let frame = RuntimeIpcFrame::Response { request_id, result };
    match timeout_write(timeout, stream, &frame).await {
        Err(RuntimeIpcServerError::Io(RuntimeIpcIoError::FrameTooLarge { .. })) => {
            send_error(
                stream,
                timeout,
                Some(request_id),
                RuntimeIpcErrorCode::FrameTooLarge,
                "runtime IPC response exceeds the supported frame size",
            )
            .await
        }
        result => result,
    }
}

fn request_id_of(frame: &RuntimeIpcFrame) -> Option<u64> {
    match frame {
        RuntimeIpcFrame::Initialize { request_id, .. }
        | RuntimeIpcFrame::Initialized { request_id, .. }
        | RuntimeIpcFrame::Request { request_id, .. }
        | RuntimeIpcFrame::Response { request_id, .. } => Some(*request_id),
        RuntimeIpcFrame::Error { request_id, .. } => *request_id,
        RuntimeIpcFrame::Event { .. } => None,
    }
}

async fn send_runtime_error(
    stream: &mut LocalIpcStream,
    timeout: Duration,
    request_id: Option<u64>,
    error: RuntimeIpcError,
) -> Result<(), RuntimeIpcServerError> {
    timeout_write(
        timeout,
        stream,
        &RuntimeIpcFrame::Error { request_id, error },
    )
    .await
}

fn valid_client_fact(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && !value.chars().any(char::is_control)
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    let length = left.len().max(right.len());
    let mut difference = left.len() ^ right.len();
    for index in 0..length {
        difference |= usize::from(
            left.get(index).copied().unwrap_or_default()
                ^ right.get(index).copied().unwrap_or_default(),
        );
    }
    difference == 0
}

fn validate_server_config(config: &RuntimeIpcServerConfig) -> Result<(), RuntimeIpcServerError> {
    if config.server_version.is_empty()
        || config.server_version.len() > 128
        || config.server_version.chars().any(char::is_control)
        || config.idle_timeout.is_zero()
        || config.handshake_timeout.is_zero()
        || config.request_timeout.is_zero()
        || config.max_connections == 0
        || config.max_connections > MAX_CONNECTION_LIMIT
    {
        return Err(RuntimeIpcServerError::InvalidConfig);
    }
    Ok(())
}

#[derive(Debug, thiserror::Error)]
pub enum RuntimeIpcServerError {
    #[error("runtime IPC server configuration is invalid")]
    InvalidConfig,
    #[error("runtime IPC connection timed out")]
    IoTimeout,
    #[error("runtime IPC client disconnected")]
    Disconnected,
    #[error("runtime IPC event stream is unavailable")]
    EventStreamUnavailable,
    #[error("runtime IPC connection task failed")]
    ConnectionTask(#[source] tokio::task::JoinError),
    #[error(transparent)]
    Discovery(#[from] RuntimeIpcDiscoveryError),
    #[error(transparent)]
    Transport(#[from] RuntimeIpcTransportError),
    #[error(transparent)]
    Io(#[from] RuntimeIpcIoError),
}
