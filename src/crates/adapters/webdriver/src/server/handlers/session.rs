use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::{
    extract::{Path, State},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::Manager;

use crate::platform;
use crate::server::response::{WebDriverErrorResponse, WebDriverResponse, WebDriverResult};
use crate::server::AppState;

#[derive(Debug, Deserialize)]
pub struct NewSessionRequest {
    capabilities: Option<Value>,
}

async fn wait_for_window(
    state: &Arc<AppState>,
    timeout_ms: u64,
) -> Result<String, WebDriverErrorResponse> {
    let start = Instant::now();
    let timeout = Duration::from_millis(timeout_ms);
    let poll_interval = Duration::from_millis(100);

    loop {
        if let Some(label) = state.initial_window_label() {
            return Ok(label);
        }

        if start.elapsed() >= timeout {
            return Err(WebDriverErrorResponse::session_not_created(format!(
                "Webview not available: {}",
                state.preferred_label
            )));
        }

        tokio::time::sleep(poll_interval).await;
    }
}

fn parse_user_agent(user_agent: &str) -> (String, String) {
    if user_agent.contains("Edg/") {
        let version = user_agent
            .split("Edg/")
            .nth(1)
            .and_then(|value| value.split_whitespace().next())
            .unwrap_or("unknown");
        return ("msedge".to_string(), version.to_string());
    }

    if let Some(version) = user_agent
        .split_once("Chrome/")
        .and_then(|(_, suffix)| suffix.split_whitespace().next())
    {
        return ("chrome".to_string(), version.to_string());
    }

    if user_agent.contains("Linux") || user_agent.contains("X11") {
        let version = user_agent
            .split("AppleWebKit/")
            .nth(1)
            .and_then(|value| value.split_whitespace().next())
            .unwrap_or("unknown");
        return ("WebKitGTK".to_string(), version.to_string());
    }

    if (user_agent.contains("iPhone") || user_agent.contains("iPad") || user_agent.contains("iPod"))
        && user_agent.contains("AppleWebKit/")
    {
        let version = user_agent
            .split("AppleWebKit/")
            .nth(1)
            .and_then(|value| value.split_whitespace().next())
            .and_then(|value| value.split('(').next())
            .unwrap_or("unknown");
        return ("webkit".to_string(), version.to_string());
    }

    if user_agent.contains("Macintosh") && user_agent.contains("AppleWebKit/") {
        let version = user_agent
            .split("AppleWebKit/")
            .nth(1)
            .and_then(|value| value.split_whitespace().next())
            .and_then(|value| value.split('(').next())
            .unwrap_or("unknown");
        return ("webkit".to_string(), version.to_string());
    }

    ("webview".to_string(), "unknown".to_string())
}

async fn detect_browser_info(state: Arc<AppState>, window_label: &str) -> (String, String) {
    let Some(webview) = state.app.get_webview(window_label) else {
        return ("webview".to_string(), "unknown".to_string());
    };

    let user_agent = platform::evaluator::evaluate_script(
        webview,
        5_000,
        "() => navigator.userAgent || ''",
        &[],
        false,
        &Value::Array(Vec::new()),
    )
    .await;

    match user_agent {
        Ok(Value::String(user_agent)) => parse_user_agent(&user_agent),
        _ => ("webview".to_string(), "unknown".to_string()),
    }
}

pub async fn create(
    State(state): State<Arc<AppState>>,
    Json(request): Json<NewSessionRequest>,
) -> WebDriverResult {
    let initial_window = wait_for_window(&state, 10_000).await?;
    let (browser_name, browser_version) = detect_browser_info(state.clone(), &initial_window).await;

    let session = state.sessions.write().await.create(initial_window.clone());

    let set_window_rect = cfg!(any(
        target_os = "macos",
        target_os = "windows",
        target_os = "linux"
    ));

    Ok(WebDriverResponse::success(json!({
        "sessionId": session.id,
        "capabilities": {
            "browserName": browser_name,
            "browserVersion": browser_version,
            "platformName": std::env::consts::OS,
            "acceptInsecureCerts": false,
            "pageLoadStrategy": "normal",
            "setWindowRect": set_window_rect,
            "takesScreenshot": cfg!(any(target_os = "macos", target_os = "windows")),
            "printPage": cfg!(any(target_os = "macos", target_os = "windows")),
            "timeouts": session.timeouts,
            "openbitfun:embedded": true,
            "openbitfun:webviewLabel": initial_window,
            "alwaysMatch": request.capabilities.unwrap_or(Value::Null)
        }
    })))
}

pub async fn delete(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> WebDriverResult {
    let removed = state.sessions.write().await.delete(&session_id);
    if !removed {
        return Err(WebDriverErrorResponse::invalid_session_id(&session_id));
    }

    Ok(WebDriverResponse::null())
}
