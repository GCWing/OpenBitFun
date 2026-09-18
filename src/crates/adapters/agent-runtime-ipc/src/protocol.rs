use serde::{Deserialize, Serialize};
use std::fmt;

use crate::{RuntimeIpcOperation, RuntimeIpcOperationResult};
use openbitfun_events::AgenticEventEnvelope;
use openbitfun_product_domains::tool_permissions::PermissionRequestEvent;

pub const PROTOCOL_VERSION: u32 = 19;
/// Upgrade-only predecessor accepted by current clients.
pub(crate) const LEGACY_WORKSPACE_PATH_PROTOCOL_VERSION: u32 = 18;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum RuntimeIpcFrame {
    Initialize {
        request_id: u64,
        request: InitializeRequest,
    },
    Initialized {
        request_id: u64,
        result: InitializeResult,
    },
    Request {
        request_id: u64,
        operation: RuntimeIpcOperation,
    },
    Response {
        request_id: u64,
        result: RuntimeIpcOperationResult,
    },
    Error {
        request_id: Option<u64>,
        error: RuntimeIpcError,
    },
    Event {
        event: RuntimeIpcEvent,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RuntimeIpcEvent {
    Agent {
        session_id: String,
        envelope: AgenticEventEnvelope,
    },
    Permission {
        session_id: String,
        event: PermissionRequestEvent,
    },
    StreamInvalidated {
        reason: RuntimeIpcStreamInvalidationReason,
    },
}

impl RuntimeIpcEvent {
    pub fn session_id(&self) -> Option<&str> {
        match self {
            Self::Agent { session_id, .. } | Self::Permission { session_id, .. } => {
                Some(session_id)
            }
            Self::StreamInvalidated { .. } => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeIpcStreamInvalidationReason {
    Lagged,
    Closed,
    FrameTooLarge,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InitializeRequest {
    pub protocol_version: u32,
    pub instance_identity: String,
    pub token: String,
    pub client_id: String,
    pub client_version: String,
}

impl fmt::Debug for InitializeRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("InitializeRequest")
            .field("protocol_version", &self.protocol_version)
            .field("instance_identity", &self.instance_identity)
            .field("token", &"[REDACTED]")
            .field("client_id", &self.client_id)
            .field("client_version", &self.client_version)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InitializeResult {
    pub protocol_version: u32,
    pub instance_identity: String,
    pub server_version: String,
    pub capabilities: RuntimeIpcCapabilities,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeIpcCapabilities {
    #[serde(default)]
    pub workspace_id_references: bool,
    pub health: bool,
    #[serde(default)]
    pub interactive_tui: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HealthResult {
    pub instance_identity: String,
    pub process_id: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeIpcErrorCode {
    InvalidRequest,
    Unauthorized,
    IncompatibleProtocol,
    WrongInstance,
    FrameTooLarge,
    NotFound,
    SessionInUse,
    ControllerRequired,
    SessionMismatch,
    OperationUnsupported,
    OutcomeUnknown,
    Unavailable,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeIpcError {
    pub code: RuntimeIpcErrorCode,
    pub message: String,
}
