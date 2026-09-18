//! Private Shared TUI IPC for discovery, framing, and leases; not a public API or Runtime owner.

mod client;
mod discovery;
mod framing;
mod handler;
mod ipc;
mod operation;
mod protocol;
mod server;
mod session_lease;

pub use client::{RuntimeIpcClient, RuntimeIpcClientError, RuntimeIpcClientEvent};
pub use discovery::{
    DiscoveryRecord, DiscoveryStore, RuntimeInstanceIdentity, RuntimeInstanceLock,
    RuntimeIpcDiscoveryError,
};
pub use framing::RuntimeIpcIoError;
pub(crate) use framing::{
    read_frame, read_frame_strict_with_limit, serialize_frame_with_limit, write_frame,
    write_frame_with_limit, write_serialized_frame_with_limit, RuntimeIpcFrameReader,
    MAX_REQUEST_FRAME_BYTES, MAX_RESPONSE_FRAME_BYTES,
};
pub use handler::RuntimeIpcRequestHandler;
pub use ipc::RuntimeIpcTransportError;
pub(crate) use ipc::{LocalIpcEndpoint, LocalIpcListener, LocalIpcStream};
pub use operation::{
    RuntimeAgentModeSummary, RuntimeIpcOperation, RuntimeIpcOperationResult,
    RuntimeSessionForkRequest, RuntimeSessionProcessingPhase, RuntimeSessionRenameRequest,
    RuntimeSessionRestoreRequest, RuntimeSessionState, RuntimeUserAnswersRequest,
};
pub use protocol::{
    HealthResult, InitializeRequest, InitializeResult, RuntimeIpcCapabilities, RuntimeIpcError,
    RuntimeIpcErrorCode, RuntimeIpcEvent, RuntimeIpcFrame, RuntimeIpcStreamInvalidationReason,
    PROTOCOL_VERSION,
};
pub use server::{RuntimeIpcServer, RuntimeIpcServerConfig, RuntimeIpcServerError};
pub(crate) use session_lease::{LeaseTransition, RuntimeSessionLeases};

#[cfg(test)]
#[path = "tests/discovery_and_framing.rs"]
mod discovery_and_framing_tests;
#[cfg(test)]
#[path = "tests/local_health.rs"]
mod local_health_tests;
#[cfg(test)]
#[path = "tests/protocol_contracts.rs"]
mod protocol_contract_tests;
#[cfg(test)]
#[path = "tests/shared_controller.rs"]
mod shared_controller_tests;

pub use operation::legacy_workspace_operation;
