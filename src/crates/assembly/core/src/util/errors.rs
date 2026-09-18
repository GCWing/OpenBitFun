//! Unified error handling
//!
//! Provide unified error types and handling for the whole application

use openbitfun_core_types::errors::{
    ai_error_detail_from_message, classify_ai_error_message, AiErrorDetail, AiProviderError,
    ErrorCategory,
};
use serde::Serialize;
use thiserror::Error;

impl From<openbitfun_services_core::storage_error::StorageError> for OpenBitFunError {
    fn from(error: openbitfun_services_core::storage_error::StorageError) -> Self {
        use openbitfun_services_core::storage_error::StorageError;
        match error {
            StorageError::Config(message) => Self::config(message),
            StorageError::Validation(message) => Self::validation(message),
            StorageError::Io(message) => Self::io(message),
            StorageError::Service(message) => Self::service(message),
            StorageError::Tool(message) => Self::tool(message),
        }
    }
}

/// Unified error type for the OpenBitFun application
#[derive(Debug, Error, Serialize)]
pub enum OpenBitFunError {
    #[error("Service error: {0}")]
    Service(String),

    #[error("Agent error: {0}")]
    Agent(String),

    #[error("Tool error: {0}")]
    Tool(String),

    #[error("{message}")]
    ClassifiedTool {
        message: String,
        detail: openbitfun_core_types::errors::ToolErrorDetail,
    },

    #[error("AI client error: {0}")]
    AIClient(String),

    #[error("AI provider error: {0}")]
    AIProvider(AiProviderError),

    /// A provider rejected the request before any effective model output because
    /// the input exceeded its context window. The execution engine may compact
    /// the session and retry the same logical model round.
    #[error("AI client error: {0}")]
    RecoverableContextOverflow(AiProviderError),

    #[error("Session error: {0}")]
    Session(String),

    #[error("Session is already open for writing: {session_id}")]
    SessionInUse { session_id: String },

    #[error("Operation outcome is unknown: {0}")]
    OutcomeUnknown(String),

    #[error(
        "Session creation persistence failed and rollback did not complete: session_id={session_id}, error={error}, cleanup_error={cleanup_error}"
    )]
    SessionCreateCleanupRequired {
        session_id: String,
        error: String,
        cleanup_error: String,
    },

    #[error("Workspace error: {0}")]
    Workspace(String),

    #[error("Validation error: {0}")]
    Validation(String),

    #[error("IO error: {0}")]
    #[serde(serialize_with = "serialize_io_error")]
    Io(#[from] std::io::Error),

    #[error("Serialization error: {0}")]
    #[serde(serialize_with = "serialize_serde_error")]
    Serialization(#[from] serde_json::Error),

    #[error("HTTP error: {0}")]
    Http(String),

    #[error("Other error: {0}")]
    #[serde(serialize_with = "serialize_anyhow_error")]
    Other(#[from] anyhow::Error),

    #[error("Semaphore acquire error: {0}")]
    Semaphore(String),

    #[error("MCP error: {0}")]
    MCPError(String),

    #[error("Process error: {0}")]
    ProcessError(String),

    #[error("Not found: {0}")]
    NotFound(String),

    #[error("Not implemented: {0}")]
    NotImplemented(String),

    #[error("Timeout: {0}")]
    Timeout(String),

    #[error("Configuration error: {0}")]
    Configuration(String),

    #[error("Deserialization error: {0}")]
    Deserialization(String),

    #[error("Cancelled: {0}")]
    Cancelled(String),
}

pub type OpenBitFunResult<T> = Result<T, OpenBitFunError>;

// Custom serialization functions for non-serializable error types
fn serialize_io_error<S>(err: &std::io::Error, serializer: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    serializer.serialize_str(&err.to_string())
}

fn serialize_serde_error<S>(err: &serde_json::Error, serializer: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    serializer.serialize_str(&err.to_string())
}

fn serialize_anyhow_error<S>(err: &anyhow::Error, serializer: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    serializer.serialize_str(&err.to_string())
}

impl OpenBitFunError {
    pub fn tool_error_detail(&self) -> Option<&openbitfun_core_types::errors::ToolErrorDetail> {
        match self {
            Self::ClassifiedTool { detail, .. } => Some(detail),
            _ => None,
        }
    }
    pub fn service<T: Into<String>>(msg: T) -> Self {
        Self::Service(msg.into())
    }

    pub fn agent<T: Into<String>>(msg: T) -> Self {
        Self::Agent(msg.into())
    }

    pub fn tool<T: Into<String>>(msg: T) -> Self {
        Self::Tool(msg.into())
    }

    pub fn config<T: Into<String>>(msg: T) -> Self {
        Self::Configuration(msg.into())
    }

    pub fn validation<T: Into<String>>(msg: T) -> Self {
        Self::Validation(msg.into())
    }

    pub fn ai<T: Into<String>>(msg: T) -> Self {
        Self::AIClient(msg.into())
    }

    pub fn http<T: Into<String>>(msg: T) -> Self {
        Self::Http(msg.into())
    }

    pub fn parse<T: Into<String>>(msg: T) -> Self {
        Self::Deserialization(msg.into())
    }

    pub fn workspace<T: Into<String>>(msg: T) -> Self {
        Self::Workspace(msg.into())
    }

    pub fn serialization<T: Into<String>>(msg: T) -> Self {
        Self::Serialization(serde_json::Error::io(std::io::Error::other(msg.into())))
    }

    pub fn session<T: Into<String>>(msg: T) -> Self {
        Self::Session(msg.into())
    }

    pub fn io<T: Into<String>>(msg: T) -> Self {
        Self::Io(std::io::Error::other(msg.into()))
    }

    pub fn cancelled<T: Into<String>>(msg: T) -> Self {
        Self::Cancelled(msg.into())
    }

    /// Infer an error category from this error for frontend-friendly classification.
    pub fn error_category(&self) -> ErrorCategory {
        match self {
            OpenBitFunError::AIClient(msg) => classify_ai_error_message(msg),
            OpenBitFunError::AIProvider(error) => error.category.clone(),
            OpenBitFunError::RecoverableContextOverflow(_) => ErrorCategory::ContextOverflow,
            OpenBitFunError::Timeout(_) => ErrorCategory::Timeout,
            OpenBitFunError::Cancelled(_) => ErrorCategory::Unknown,
            _ => ErrorCategory::Unknown,
        }
    }

    /// Build a structured, provider-agnostic AI error detail for UI recovery.
    pub fn error_detail(&self) -> AiErrorDetail {
        if let OpenBitFunError::AIProvider(error)
        | OpenBitFunError::RecoverableContextOverflow(error) = self
        {
            return error.detail();
        }
        let category = self.error_category();
        let message = self.to_string();
        ai_error_detail_from_message(&message, category)
    }

    pub fn is_recoverable_context_overflow(&self) -> bool {
        matches!(self, Self::RecoverableContextOverflow(_))
    }
}

#[cfg(feature = "agent-runtime")]
impl From<openbitfun_agent_stream::StreamProcessorError> for OpenBitFunError {
    fn from(error: openbitfun_agent_stream::StreamProcessorError) -> Self {
        match error {
            openbitfun_agent_stream::StreamProcessorError::AiClient(msg) => Self::AIClient(msg),
            openbitfun_agent_stream::StreamProcessorError::AiProvider(error) => {
                Self::AIProvider(error)
            }
            openbitfun_agent_stream::StreamProcessorError::Cancelled(msg) => Self::Cancelled(msg),
        }
    }
}

#[cfg(feature = "agent-runtime")]
impl From<openbitfun_agent_runtime::event_bus::EventBusError> for OpenBitFunError {
    fn from(error: openbitfun_agent_runtime::event_bus::EventBusError) -> Self {
        Self::Agent(error.to_string())
    }
}

#[cfg(feature = "agent-runtime")]
impl From<openbitfun_agent_tools::computer_use::ComputerUseContractError> for OpenBitFunError {
    fn from(error: openbitfun_agent_tools::computer_use::ComputerUseContractError) -> Self {
        Self::Tool(error.to_string())
    }
}

#[cfg(feature = "mcp-runtime")]
impl From<openbitfun_services_integrations::mcp::MCPRuntimeError> for OpenBitFunError {
    fn from(error: openbitfun_services_integrations::mcp::MCPRuntimeError) -> Self {
        use openbitfun_services_integrations::mcp::MCPRuntimeErrorKind;

        let message = error.message().to_string();
        match error.kind() {
            MCPRuntimeErrorKind::Configuration => Self::Configuration(message),
            MCPRuntimeErrorKind::Validation => Self::Validation(message),
            MCPRuntimeErrorKind::Io => Self::io(message),
            MCPRuntimeErrorKind::Serialization => Self::serialization(message),
            MCPRuntimeErrorKind::Deserialization => Self::Deserialization(message),
            MCPRuntimeErrorKind::Process => Self::ProcessError(message),
            MCPRuntimeErrorKind::MCP => Self::MCPError(message),
            MCPRuntimeErrorKind::NotFound => Self::NotFound(message),
            MCPRuntimeErrorKind::NotImplemented => Self::NotImplemented(message),
            MCPRuntimeErrorKind::Timeout => Self::Timeout(message),
            MCPRuntimeErrorKind::Other => Self::Other(anyhow::anyhow!(message)),
        }
    }
}

impl From<OpenBitFunError> for String {
    fn from(err: OpenBitFunError) -> String {
        err.to_string()
    }
}

impl From<String> for OpenBitFunError {
    fn from(error: String) -> Self {
        OpenBitFunError::Service(error)
    }
}

impl From<&str> for OpenBitFunError {
    fn from(error: &str) -> Self {
        OpenBitFunError::Service(error.to_string())
    }
}
