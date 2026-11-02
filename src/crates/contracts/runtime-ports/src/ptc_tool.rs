//! Provider-neutral port for executing a PTC program.

use crate::{PortError, PortErrorKind, PortResult, RuntimeServiceCapability};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum PtcRuntimeAvailability {
    Available { executable: String, version: String },
    Unavailable { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PtcToolBinding {
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PtcExecutionRequest {
    pub operation_id: String,
    pub source: String,
    pub bindings: Vec<PtcToolBinding>,
    pub working_directory: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_bytes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PtcExecutionResponse {
    pub value: Value,
    #[serde(default)]
    pub logs: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PtcNestedToolCall {
    pub operation_id: String,
    pub tool_name: String,
    pub arguments: Value,
}

/// A PTC-local request to load the definition of a deferred tool.
///
/// This is deliberately separate from the native `GetToolSpec` tool call. The
/// PTC host keeps the loaded definition in the current runtime operation rather
/// than adding a model-visible tool result to the conversation history.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PtcToolSpecRequest {
    pub operation_id: String,
    pub tool_name: String,
}

#[async_trait]
pub trait PtcToolCallHandler: Send + Sync {
    async fn call(&self, request: PtcNestedToolCall) -> PortResult<Value>;

    async fn get_tool_spec(&self, request: PtcToolSpecRequest) -> PortResult<Value> {
        let _ = request;
        Err(PortError::new(
            PortErrorKind::NotAvailable,
            "PTC deferred tool definition loading is unavailable",
        ))
    }
}

#[async_trait]
pub trait PtcRuntime: Send + Sync {
    fn capability(&self) -> RuntimeServiceCapability {
        RuntimeServiceCapability::PtcRuntime
    }

    async fn availability(&self) -> PtcRuntimeAvailability;

    async fn execute(
        &self,
        request: PtcExecutionRequest,
        handler: Arc<dyn PtcToolCallHandler>,
    ) -> PortResult<PtcExecutionResponse>;

    async fn cancel(&self, operation_id: &str) -> PortResult<()>;
}
