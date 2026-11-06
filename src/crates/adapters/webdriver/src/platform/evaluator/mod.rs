use std::time::Duration;

use serde_json::{json, Value};
use tauri::Webview;

use super::call_devtools;
use crate::runtime::{script, BridgeError, BridgeResponse};
use crate::server::response::WebDriverErrorResponse;

pub(crate) async fn evaluate_script(
    webview: Webview,
    timeout_ms: u64,
    script_source: &str,
    args: &[Value],
    async_mode: bool,
    frame_context: &Value,
) -> Result<Value, WebDriverErrorResponse> {
    let reply = call_devtools(
        &webview,
        "Runtime.evaluate",
        json!({
            "expression": script::build_native_eval_script(
                script_source, args, async_mode, frame_context
            ),
            "awaitPromise": true,
            "returnByValue": true,
        }),
        Duration::from_millis(timeout_ms),
    )
    .await
    .map_err(|error| {
        if error.starts_with("Runtime.evaluate: timed out") {
            WebDriverErrorResponse::timeout(error)
        } else {
            WebDriverErrorResponse::javascript_error(error, None)
        }
    })?;
    if let Some(exception) = reply.get("exceptionDetails") {
        return Err(WebDriverErrorResponse::javascript_error(
            exception.to_string(),
            None,
        ));
    }
    let value = reply
        .pointer("/result/value")
        .cloned()
        .unwrap_or(Value::Null);
    let response: BridgeResponse = serde_json::from_value(value).map_err(|error| {
        WebDriverErrorResponse::unknown_error(format!("Invalid CEF script response: {error}"))
    })?;
    if response.ok {
        return Ok(response.value.unwrap_or(Value::Null));
    }
    let error = response.error.unwrap_or(BridgeError {
        message: None,
        stack: None,
    });
    Err(WebDriverErrorResponse::javascript_error(
        error
            .message
            .unwrap_or_else(|| "Unknown JavaScript error".into()),
        error.stack,
    ))
}
