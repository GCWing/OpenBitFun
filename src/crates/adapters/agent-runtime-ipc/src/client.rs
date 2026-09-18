use crate::{
    read_frame_strict_with_limit, serialize_frame_with_limit, write_frame,
    write_serialized_frame_with_limit, DiscoveryRecord, HealthResult, InitializeRequest,
    LocalIpcEndpoint, RuntimeIpcCapabilities, RuntimeIpcError, RuntimeIpcFrame,
    RuntimeIpcFrameReader, RuntimeIpcIoError, RuntimeIpcOperation, RuntimeIpcOperationResult,
    RuntimeIpcTransportError, MAX_REQUEST_FRAME_BYTES, MAX_RESPONSE_FRAME_BYTES, PROTOCOL_VERSION,
};
use std::fmt;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{broadcast, mpsc, oneshot, watch, Mutex, OwnedMutexGuard};

const CLIENT_EVENT_BUFFER: usize = 256;
const CLIENT_COMMAND_BUFFER: usize = 64;

#[derive(Debug, Clone, PartialEq)]
pub enum RuntimeIpcClientEvent {
    Runtime(crate::RuntimeIpcEvent),
    Disconnected,
}

#[derive(Clone)]
pub struct RuntimeIpcClient {
    commands: mpsc::Sender<ClientCommand>,
    instance_identity: String,
    request_timeout: Duration,
    request_gate: Arc<Mutex<()>>,
    next_request_id: Arc<AtomicU64>,
    events: broadcast::Sender<RuntimeIpcClientEvent>,
    capabilities: RuntimeIpcCapabilities,
    disconnect: watch::Sender<bool>,
}

struct ClientCommand {
    request_id: u64,
    frame_bytes: Vec<u8>,
    response: oneshot::Sender<PendingResponse>,
    deadline: tokio::time::Instant,
    release_gate_after_write: bool,
    _request_gate: Option<OwnedMutexGuard<()>>,
}

struct PendingRequest {
    response: oneshot::Sender<PendingResponse>,
    request_gate: Option<OwnedMutexGuard<()>>,
    release_gate_after_write: bool,
}

struct ClientWrite {
    request_id: u64,
    frame_bytes: Vec<u8>,
    deadline: tokio::time::Instant,
}

enum ClientWriteOutcome {
    Complete {
        request_id: u64,
    },
    Timeout {
        request_id: u64,
    },
    FrameTooLarge {
        request_id: u64,
        error: RuntimeIpcIoError,
    },
    Disconnected {
        request_id: u64,
    },
}

enum PendingResponse {
    Result(RuntimeIpcOperationResult),
    Remote(RuntimeIpcError),
    Timeout,
    Io(RuntimeIpcIoError),
    Disconnected,
}

impl fmt::Debug for RuntimeIpcClient {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RuntimeIpcClient")
            .field("instance_identity", &self.instance_identity)
            .field("request_timeout", &self.request_timeout)
            .field("capabilities", &self.capabilities)
            .finish_non_exhaustive()
    }
}

impl RuntimeIpcClient {
    pub async fn connect(
        runtime_root: &Path,
        discovery: &DiscoveryRecord,
        client_id: &str,
        client_version: &str,
        connect_timeout: Duration,
        request_timeout: Duration,
    ) -> Result<Self, RuntimeIpcClientError> {
        if connect_timeout.is_zero() || request_timeout.is_zero() {
            return Err(RuntimeIpcClientError::InvalidTimeout);
        }
        if discovery.protocol_version != PROTOCOL_VERSION
            && discovery.protocol_version != crate::protocol::LEGACY_WORKSPACE_PATH_PROTOCOL_VERSION
        {
            return Err(RuntimeIpcClientError::IncompatibleProtocol {
                expected: PROTOCOL_VERSION,
                observed: discovery.protocol_version,
            });
        }
        validate_client_fact(client_id)?;
        validate_client_fact(client_version)?;
        let endpoint = LocalIpcEndpoint::parse_for_root(
            &discovery.endpoint,
            runtime_root,
            &discovery.instance_identity,
        )?;
        let mut stream = endpoint.connect(connect_timeout).await?;
        let request_id = 1;
        timeout_io(
            connect_timeout,
            write_frame(
                &mut stream,
                &RuntimeIpcFrame::Initialize {
                    request_id,
                    request: InitializeRequest {
                        protocol_version: discovery.protocol_version,
                        instance_identity: discovery.instance_identity.as_str().to_string(),
                        token: discovery.token.clone(),
                        client_id: client_id.to_string(),
                        client_version: client_version.to_string(),
                    },
                },
            ),
        )
        .await?;
        let response = timeout_io(
            connect_timeout,
            read_frame_strict_with_limit(&mut stream, MAX_RESPONSE_FRAME_BYTES),
        )
        .await?;
        let capabilities = match response {
            RuntimeIpcFrame::Initialized {
                request_id: response_id,
                result,
            } if response_id == request_id
                && result.protocol_version == discovery.protocol_version
                && result.instance_identity == discovery.instance_identity.as_str()
                && result.capabilities.health =>
            {
                result.capabilities
            }
            RuntimeIpcFrame::Error {
                request_id: Some(response_id),
                error,
            } if response_id == request_id => return Err(RuntimeIpcClientError::Remote(error)),
            _ => return Err(RuntimeIpcClientError::UnexpectedResponse),
        };

        let (events, _) = broadcast::channel(CLIENT_EVENT_BUFFER);
        let (commands, command_rx) = mpsc::channel(CLIENT_COMMAND_BUFFER);
        let (disconnect, disconnect_rx) = watch::channel(false);
        tokio::spawn(run_connection(
            stream,
            command_rx,
            events.clone(),
            disconnect_rx,
        ));

        Ok(Self {
            commands,
            instance_identity: discovery.instance_identity.as_str().to_string(),
            request_timeout,
            request_gate: Arc::new(Mutex::new(())),
            next_request_id: Arc::new(AtomicU64::new(2)),
            events,
            capabilities,
            disconnect,
        })
    }

    pub fn capabilities(&self) -> &RuntimeIpcCapabilities {
        &self.capabilities
    }

    pub fn subscribe_events(&self) -> broadcast::Receiver<RuntimeIpcClientEvent> {
        self.events.subscribe()
    }

    pub async fn request(
        &self,
        operation: RuntimeIpcOperation,
    ) -> Result<RuntimeIpcOperationResult, RuntimeIpcClientError> {
        let request_gate = self.request_gate.clone().lock_owned().await;
        let release_gate_after_write = operation.is_interruptible_lineage_read();
        let request_id = self
            .next_request_id
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                value.checked_add(1)
            })
            .map_err(|_| RuntimeIpcClientError::RequestIdExhausted)?;
        let frame_bytes = serialize_frame_with_limit(
            &RuntimeIpcFrame::Request {
                request_id,
                operation,
            },
            MAX_REQUEST_FRAME_BYTES,
        )
        .map_err(RuntimeIpcClientError::RequestEncoding)?;
        let deadline = tokio::time::Instant::now() + self.request_timeout;
        let (sender, receiver) = oneshot::channel();
        match tokio::time::timeout_at(
            deadline,
            self.commands.send(ClientCommand {
                request_id,
                frame_bytes,
                response: sender,
                deadline,
                release_gate_after_write,
                _request_gate: Some(request_gate),
            }),
        )
        .await
        {
            Err(_) => {
                let _ = self.disconnect.send(true);
                return Err(RuntimeIpcClientError::Timeout);
            }
            Ok(Err(_)) => return Err(RuntimeIpcClientError::Disconnected),
            Ok(Ok(())) => {}
        }

        let response = match tokio::time::timeout_at(deadline, receiver).await {
            Err(_) => {
                let _ = self.disconnect.send(true);
                return Err(RuntimeIpcClientError::Timeout);
            }
            Ok(Err(_)) => return Err(RuntimeIpcClientError::Disconnected),
            Ok(Ok(response)) => response,
        };
        match response {
            PendingResponse::Result(result) => Ok(result),
            PendingResponse::Remote(error) => Err(RuntimeIpcClientError::Remote(error)),
            PendingResponse::Timeout => Err(RuntimeIpcClientError::Timeout),
            PendingResponse::Io(error) => Err(RuntimeIpcClientError::Io(error)),
            PendingResponse::Disconnected => Err(RuntimeIpcClientError::Disconnected),
        }
    }

    pub async fn health(&self) -> Result<HealthResult, RuntimeIpcClientError> {
        match self.request(RuntimeIpcOperation::Health).await? {
            RuntimeIpcOperationResult::Health {
                instance_identity,
                process_id,
            } if instance_identity == self.instance_identity => Ok(HealthResult {
                instance_identity,
                process_id,
            }),
            _ => Err(RuntimeIpcClientError::UnexpectedResponse),
        }
    }
}

async fn run_connection<S>(
    stream: S,
    mut commands: mpsc::Receiver<ClientCommand>,
    events: broadcast::Sender<RuntimeIpcClientEvent>,
    mut disconnect: watch::Receiver<bool>,
) where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (mut reader, writer) = tokio::io::split(stream);
    let (writes, write_rx) = mpsc::channel(1);
    let (write_outcomes, mut write_outcome_rx) = mpsc::unbounded_channel();
    let writer = tokio::spawn(run_writer(writer, write_rx, write_outcomes));
    let mut pending = std::collections::HashMap::new();
    let mut frames = RuntimeIpcFrameReader::new(MAX_RESPONSE_FRAME_BYTES);
    loop {
        tokio::select! {
            biased;
            changed = disconnect.changed() => {
                if changed.is_err() || *disconnect.borrow() {
                    break;
                }
            }
            command = commands.recv() => {
                let Some(command) = command else {
                    break;
                };
                let request_id = command.request_id;
                if tokio::time::Instant::now() >= command.deadline {
                    let _ = command.response.send(PendingResponse::Timeout);
                    continue;
                }
                pending.insert(request_id, PendingRequest {
                    response: command.response,
                    request_gate: command._request_gate,
                    release_gate_after_write: command.release_gate_after_write,
                });
                if writes.try_send(ClientWrite {
                    request_id,
                    frame_bytes: command.frame_bytes,
                    deadline: command.deadline,
                }).is_err() {
                    if let Some(request) = pending.remove(&request_id) {
                        let _ = request.response.send(PendingResponse::Disconnected);
                    }
                    break;
                }
            },
            outcome = write_outcome_rx.recv() => match outcome {
                Some(ClientWriteOutcome::Complete { request_id }) => {
                    if let Some(request) = pending.get_mut(&request_id) {
                        if request.release_gate_after_write {
                            request.request_gate.take();
                        }
                    }
                }
                Some(ClientWriteOutcome::FrameTooLarge { request_id, error }) => {
                    if let Some(request) = pending.remove(&request_id) {
                        let _ = request.response.send(PendingResponse::Io(error));
                    }
                }
                Some(ClientWriteOutcome::Timeout { request_id }) => {
                    if let Some(request) = pending.remove(&request_id) {
                        let _ = request.response.send(PendingResponse::Timeout);
                    }
                    break;
                }
                Some(ClientWriteOutcome::Disconnected { request_id }) => {
                    if let Some(request) = pending.remove(&request_id) {
                        let _ = request.response.send(PendingResponse::Disconnected);
                    }
                    break;
                }
                None => break,
            },
            frame = frames.read_strict(&mut reader) => match frame {
                Ok(RuntimeIpcFrame::Response { request_id, result }) => {
                    if let Some(request) = pending.remove(&request_id) {
                        let _ = request.response.send(PendingResponse::Result(result));
                    } else {
                        break;
                    }
                }
                Ok(RuntimeIpcFrame::Error {
                    request_id: Some(request_id),
                    error,
                }) => {
                    if let Some(request) = pending.remove(&request_id) {
                        let _ = request.response.send(PendingResponse::Remote(error));
                    } else {
                        break;
                    }
                }
                Ok(RuntimeIpcFrame::Event { event }) => {
                    let _ = events.send(RuntimeIpcClientEvent::Runtime(event));
                }
                Ok(_) | Err(_) => break,
            }
        }
    }

    drop(writes);
    writer.abort();
    let _ = writer.await;
    for (_, request) in pending.drain() {
        let _ = request.response.send(PendingResponse::Disconnected);
    }
    let _ = events.send(RuntimeIpcClientEvent::Disconnected);
}

async fn run_writer<W>(
    mut writer: W,
    mut writes: mpsc::Receiver<ClientWrite>,
    outcomes: mpsc::UnboundedSender<ClientWriteOutcome>,
) where
    W: tokio::io::AsyncWrite + Unpin,
{
    while let Some(write) = writes.recv().await {
        let request_id = write.request_id;
        let outcome = match tokio::time::timeout_at(
            write.deadline,
            write_serialized_frame_with_limit(
                &mut writer,
                &write.frame_bytes,
                MAX_REQUEST_FRAME_BYTES,
            ),
        )
        .await
        {
            Err(_) => ClientWriteOutcome::Timeout { request_id },
            Ok(Err(error @ RuntimeIpcIoError::FrameTooLarge { .. })) => {
                ClientWriteOutcome::FrameTooLarge { request_id, error }
            }
            Ok(Err(_)) => ClientWriteOutcome::Disconnected { request_id },
            Ok(Ok(())) => ClientWriteOutcome::Complete { request_id },
        };
        let terminal = matches!(
            outcome,
            ClientWriteOutcome::Timeout { .. } | ClientWriteOutcome::Disconnected { .. }
        );
        if outcomes.send(outcome).is_err() || terminal {
            break;
        }
    }
}

async fn timeout_io<T>(
    timeout: Duration,
    future: impl std::future::Future<Output = Result<T, RuntimeIpcIoError>>,
) -> Result<T, RuntimeIpcClientError> {
    tokio::time::timeout(timeout, future)
        .await
        .map_err(|_| RuntimeIpcClientError::Timeout)?
        .map_err(RuntimeIpcClientError::Io)
}

fn validate_client_fact(value: &str) -> Result<(), RuntimeIpcClientError> {
    if value.is_empty() || value.len() > 128 || value.chars().any(char::is_control) {
        return Err(RuntimeIpcClientError::InvalidClientIdentity);
    }
    Ok(())
}

#[derive(Debug, thiserror::Error)]
pub enum RuntimeIpcClientError {
    #[error("runtime IPC protocol mismatch: expected {expected}, observed {observed}")]
    IncompatibleProtocol { expected: u32, observed: u32 },
    #[error("runtime IPC client identity is invalid")]
    InvalidClientIdentity,
    #[error("runtime IPC request timed out")]
    Timeout,
    #[error("runtime IPC connection closed")]
    Disconnected,
    #[error("runtime IPC returned an unexpected response")]
    UnexpectedResponse,
    #[error("runtime IPC request identifiers are exhausted")]
    RequestIdExhausted,
    #[error("runtime IPC request could not be encoded")]
    RequestEncoding(#[source] RuntimeIpcIoError),
    #[error("runtime IPC timeouts must be greater than zero")]
    InvalidTimeout,
    #[error("runtime IPC request was rejected: {0:?}")]
    Remote(RuntimeIpcError),
    #[error(transparent)]
    Transport(#[from] RuntimeIpcTransportError),
    #[error(transparent)]
    Io(#[from] RuntimeIpcIoError),
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{write_frame_with_limit, RuntimeSessionRenameRequest};

    #[tokio::test]
    async fn connection_reads_a_large_response_while_a_large_request_is_still_writing() {
        let (client_stream, mut server_stream) = tokio::io::duplex(64);
        let (commands, command_rx) = mpsc::channel(CLIENT_COMMAND_BUFFER);
        let (events, _) = broadcast::channel(CLIENT_EVENT_BUFFER);
        let (disconnect, disconnect_rx) = watch::channel(false);
        let connection = tokio::spawn(run_connection(
            client_stream,
            command_rx,
            events,
            disconnect_rx,
        ));

        let server = tokio::spawn(async move {
            let mut frames = RuntimeIpcFrameReader::new(MAX_REQUEST_FRAME_BYTES);
            let first = frames.read_strict(&mut server_stream).await.unwrap();
            assert!(matches!(
                first,
                RuntimeIpcFrame::Request { request_id: 2, .. }
            ));

            // Observe the second write without draining it. With a single
            // read/write task this fills both directions and deadlocks.
            frames
                .wait_for_frame_start(&mut server_stream)
                .await
                .unwrap();
            write_frame_with_limit(
                &mut server_stream,
                &RuntimeIpcFrame::Response {
                    request_id: 2,
                    result: RuntimeIpcOperationResult::Health {
                        instance_identity: "response".repeat(4_096),
                        process_id: 7,
                    },
                },
                MAX_RESPONSE_FRAME_BYTES,
            )
            .await
            .unwrap();

            let second = frames.read_strict(&mut server_stream).await.unwrap();
            assert!(matches!(
                second,
                RuntimeIpcFrame::Request { request_id: 3, .. }
            ));
            write_frame_with_limit(
                &mut server_stream,
                &RuntimeIpcFrame::Response {
                    request_id: 3,
                    result: RuntimeIpcOperationResult::Unit,
                },
                MAX_RESPONSE_FRAME_BYTES,
            )
            .await
            .unwrap();
        });

        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        let request_gate = Arc::new(Mutex::new(()));
        let (first_sender, first_response) = oneshot::channel();
        commands
            .send(ClientCommand {
                request_id: 2,
                frame_bytes: serialize_frame_with_limit(
                    &RuntimeIpcFrame::Request {
                        request_id: 2,
                        operation: RuntimeIpcOperation::Health,
                    },
                    MAX_REQUEST_FRAME_BYTES,
                )
                .unwrap(),
                response: first_sender,
                deadline,
                release_gate_after_write: true,
                _request_gate: Some(request_gate.clone().lock_owned().await),
            })
            .await
            .unwrap();

        let (second_sender, second_response) = oneshot::channel();
        let second_request_gate = request_gate.lock_owned().await;
        commands
            .send(ClientCommand {
                request_id: 3,
                frame_bytes: serialize_frame_with_limit(
                    &RuntimeIpcFrame::Request {
                        request_id: 3,
                        operation: RuntimeIpcOperation::RenameSession {
                            request: RuntimeSessionRenameRequest {
                                session_id: "session".to_string(),
                                session_name: "request".repeat(8_192),
                            },
                        },
                    },
                    MAX_REQUEST_FRAME_BYTES,
                )
                .unwrap(),
                response: second_sender,
                deadline,
                release_gate_after_write: false,
                _request_gate: Some(second_request_gate),
            })
            .await
            .unwrap();

        tokio::time::timeout(Duration::from_millis(500), async {
            assert!(matches!(
                first_response.await.unwrap(),
                PendingResponse::Result(RuntimeIpcOperationResult::Health { .. })
            ));
            assert!(matches!(
                second_response.await.unwrap(),
                PendingResponse::Result(RuntimeIpcOperationResult::Unit)
            ));
            server.await.unwrap();
        })
        .await
        .expect("full-duplex IPC must continue reading while a request write is backpressured");

        let _ = disconnect.send(true);
        connection.await.unwrap();
    }
}
