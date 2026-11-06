use std::sync::Arc;

use serde_json::{json, Value};

use crate::runtime::run_script;
use crate::server::response::WebDriverErrorResponse;
use crate::server::AppState;

// The bridge and its element store belong to the native top-level document.
// Command scripts still execute in the selected frame, so unqualified window
// and document keep that frame's DOM semantics.

pub(crate) fn perform_actions() -> &'static str {
    "async (actions) => { await window.top.__openbitfunWd.performActions(actions); return null; }"
}

pub(crate) fn release_actions() -> &'static str {
    "async (pressedKeys, pressedButtons) => { await window.top.__openbitfunWd.releaseActions(pressedKeys, pressedButtons); return null; }"
}

pub(crate) fn dismiss_alert() -> &'static str {
    "() => window.top.__openbitfunWd.closeAlert(false)"
}

pub(crate) fn accept_alert() -> &'static str {
    "() => window.top.__openbitfunWd.closeAlert(true)"
}

pub(crate) fn alert_text() -> &'static str {
    "() => window.top.__openbitfunWd.getAlertText()"
}

pub(crate) fn send_alert_text() -> &'static str {
    "(text) => window.top.__openbitfunWd.sendAlertText(text)"
}

pub(crate) fn take_logs() -> &'static str {
    "() => window.top.__openbitfunWd.takeLogs()"
}

pub(crate) async fn exec_perform_actions(
    state: Arc<AppState>,
    session_id: &str,
    actions: &[Value],
) -> Result<(), WebDriverErrorResponse> {
    run_script(
        state,
        session_id,
        perform_actions(),
        vec![Value::Array(actions.to_vec())],
        false,
    )
    .await?;
    Ok(())
}

pub(crate) async fn exec_release_actions(
    state: Arc<AppState>,
    session_id: &str,
    pressed_keys: Vec<String>,
    pressed_buttons: Vec<Value>,
) -> Result<(), WebDriverErrorResponse> {
    run_script(
        state,
        session_id,
        release_actions(),
        vec![json!(pressed_keys), Value::Array(pressed_buttons)],
        false,
    )
    .await?;
    Ok(())
}

pub(crate) async fn exec_alert_action(
    state: Arc<AppState>,
    session_id: &str,
    script: &str,
) -> Result<(), WebDriverErrorResponse> {
    run_script(state, session_id, script, Vec::new(), false).await?;
    Ok(())
}

pub(crate) async fn exec_alert_text(
    state: Arc<AppState>,
    session_id: &str,
) -> Result<Value, WebDriverErrorResponse> {
    run_script(state, session_id, alert_text(), Vec::new(), false).await
}

pub(crate) async fn exec_send_alert_text(
    state: Arc<AppState>,
    session_id: &str,
    text: &str,
) -> Result<(), WebDriverErrorResponse> {
    run_script(
        state,
        session_id,
        send_alert_text(),
        vec![Value::String(text.to_string())],
        false,
    )
    .await?;
    Ok(())
}

pub(crate) async fn exec_take_logs(
    state: Arc<AppState>,
    session_id: &str,
) -> Result<Value, WebDriverErrorResponse> {
    run_script(state, session_id, take_logs(), Vec::new(), false).await
}
