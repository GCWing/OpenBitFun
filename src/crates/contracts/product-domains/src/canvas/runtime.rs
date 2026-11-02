use super::sdk_contract_generated::{
    OPENBITFUN_CANVAS_RUNTIME_VERSION, OPENBITFUN_CANVAS_SDK_VERSION,
};
use crate::canvas::types::{CanvasCompiledPayload, CanvasDiagnostic, CanvasId, CanvasRevision};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasCompileRequest {
    pub canvas_id: CanvasId,
    pub source_revision: CanvasRevision,
    pub source: String,
    #[serde(default = "default_sdk_version")]
    pub sdk_version: String,
    #[serde(default = "default_runtime_version")]
    pub runtime_version: String,
    pub compiled_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasCompileResult {
    pub payload: Option<CanvasCompiledPayload>,
    pub diagnostics: Vec<CanvasDiagnostic>,
    pub compiled: bool,
}

fn default_sdk_version() -> String {
    OPENBITFUN_CANVAS_SDK_VERSION.to_string()
}

fn default_runtime_version() -> String {
    OPENBITFUN_CANVAS_RUNTIME_VERSION.to_string()
}
