use std::sync::Arc;

use serde::Deserialize;
use serde_json::Value;
use tauri::Manager;

use crate::platform;
use crate::server::response::WebDriverErrorResponse;
use crate::server::AppState;

pub(crate) mod api;
pub(crate) mod script;

#[derive(Debug, Deserialize)]
pub(crate) struct BridgeResponse {
    pub(crate) ok: bool,
    pub(crate) value: Option<Value>,
    pub(crate) error: Option<BridgeError>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct BridgeError {
    pub(crate) message: Option<String>,
    pub(crate) stack: Option<String>,
}

pub(crate) async fn run_script(
    state: Arc<AppState>,
    session_id: &str,
    script_source: &str,
    args: Vec<Value>,
    async_mode: bool,
) -> Result<Value, WebDriverErrorResponse> {
    let session = state.sessions.read().await.get_cloned(session_id)?;
    let timeout_ms = session.timeouts.script.max(5_000);
    let webview = state
        .app
        .get_webview(&session.current_window)
        .ok_or_else(|| {
            WebDriverErrorResponse::no_such_window(format!(
                "Webview not found: {}",
                session.current_window
            ))
        })?;

    let frame_context = script::serialize_frame_context(&session.frame_context);

    platform::evaluator::evaluate_script(
        webview,
        timeout_ms,
        script_source,
        &args,
        async_mode,
        &frame_context,
    )
    .await
}
