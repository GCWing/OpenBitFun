//! Unified ControlHub response envelope.
//!
//! Every ControlHub action returns a single JSON object whose top-level shape
//! is stable across all domains:
//!
//! ```jsonc
//! // success
//! {
//!   "ok": true,
//!   "domain": "browser",
//!   "action": "click",
//!   "data": { /* domain-specific payload */ },
//!   "warnings": [ "..." ],          // optional
//!   "capability": { ... }           // optional snapshot relevant to this call
//! }
//! // failure
//! {
//!   "ok": false,
//!   "domain": "...",
//!   "action": "...",
//!   "error": {
//!     "code": "STALE_REF" | "NOT_FOUND" | ...,
//!     "message": "...",
//!     "hints": [ "...next step suggestion..." ]
//!   }
//! }
//! ```
//!
//! Models can branch on `ok` and on `error.code` (see [`super::errors::ErrorCode`])
//! to recover deterministically without parsing English error text.

use super::errors::ErrorCode;
use crate::agentic::tools::framework::ToolResult;
use crate::util::errors::OpenBitFunError;
use serde_json::{json, Value};

/// Lightweight error type carried inside a successful tool call (vs returning
/// `Err`). ControlHub prefers this envelope so the model receives the same
/// JSON shape on success and failure and can retry deterministically.
#[derive(Debug, Clone)]
pub struct ControlHubError {
    pub code: ErrorCode,
    pub message: String,
    pub hints: Vec<String>,
}

impl ControlHubError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            hints: Vec::new(),
        }
    }

    pub fn with_hint(mut self, hint: impl Into<String>) -> Self {
        self.hints.push(hint.into());
        self
    }

    pub fn with_hints<I, S>(mut self, hints: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.hints.extend(hints.into_iter().map(Into::into));
        self
    }

    pub fn to_value(&self) -> Value {
        json!({
            "code": self.code.as_str(),
            "message": self.message,
            "hints": self.hints,
        })
    }
}

/// Build the success envelope.
pub fn ok_response(
    domain: &str,
    action: &str,
    data: Value,
    summary_for_assistant: Option<String>,
) -> Vec<ToolResult> {
    let body = json!({
        "ok": true,
        "domain": domain,
        "action": action,
        "data": data,
    });
    vec![ToolResult::ok(body, summary_for_assistant)]
}

/// Build the success envelope with extra optional fields (warnings, capability).
pub fn ok_response_full(
    domain: &str,
    action: &str,
    data: Value,
    summary_for_assistant: Option<String>,
    warnings: Vec<String>,
    capability: Option<Value>,
) -> Vec<ToolResult> {
    let mut body = json!({
        "ok": true,
        "domain": domain,
        "action": action,
        "data": data,
    });
    if !warnings.is_empty() {
        if let Some(obj) = body.as_object_mut() {
            obj.insert("warnings".to_string(), json!(warnings));
        }
    }
    if let Some(cap) = capability {
        if let Some(obj) = body.as_object_mut() {
            obj.insert("capability".to_string(), cap);
        }
    }
    vec![ToolResult::ok(body, summary_for_assistant)]
}

/// Build the failure envelope as a *successful* tool call (so the model
/// receives the structured error JSON instead of a plain OpenBitFunError text).
pub fn err_response(domain: &str, action: &str, err: ControlHubError) -> Vec<ToolResult> {
    let summary = error_summary(&err.to_value());
    let body = json!({
        "ok": false,
        "domain": domain,
        "action": action,
        "error": err.to_value(),
    });
    vec![ToolResult::ok(body, Some(summary))]
}

/// Keep recovery evidence in the model-visible projection as well as UI JSON.
pub fn error_summary(error: &Value) -> String {
    let mut text = format!(
        "{}: {}",
        error["code"].as_str().unwrap_or("ERROR"),
        error["message"].as_str().unwrap_or("")
    );
    if let Some(hints) = error["hints"].as_array() {
        for hint in hints.iter().filter_map(Value::as_str) {
            text.push_str("\n- ");
            text.push_str(hint);
        }
    }
    text
}

/// Builds a `OpenBitFunError` whose message is prefixed with `[CODE]` using the
/// canonical [`ErrorCode`] instead of a hand-typed string literal (e.g.
/// `"[INVALID_PARAMS] ..."`). Callers that cannot return the full
/// `ControlHubError` envelope (e.g. `?`-propagated parameter validation) use
/// this so the bracket prefix can never drift from the enum that
/// [`super::errors::ErrorCode::from_str`] / `map_dispatch_error` parse it
/// back into.
pub fn coded_tool_error(code: ErrorCode, message: impl std::fmt::Display) -> OpenBitFunError {
    OpenBitFunError::tool(format!("[{}] {}", code.as_str(), message))
}

/// Convenience: lift a `OpenBitFunError` into the structured envelope using the
/// supplied default error code. Used as a fallback when an underlying domain
/// implementation still returns `Err` instead of a structured envelope.
pub fn lift_error(
    domain: &str,
    action: &str,
    default_code: ErrorCode,
    err: OpenBitFunError,
) -> Vec<ToolResult> {
    err_response(
        domain,
        action,
        ControlHubError::new(default_code, err.to_string()),
    )
}
