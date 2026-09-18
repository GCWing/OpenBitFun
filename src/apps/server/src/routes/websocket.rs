//! WebSocket handler.
//!
//! Under browser-direct ACP-over-WS (Step 2), the browser speaks raw JSON-RPC
//! 2.0 over the WebSocket. Each connection is handed straight to
//! [`openbitfun_app_server::OpenBitFunAppServer::serve`] via the [`super::ws_transport`]
//! `Lines` adapter -- no custom `{type:"request"|...}` envelope, no
//! `route_agent_command`, no shared in-process client. The browser connects
//! directly to the in-process app-server over native JSON-RPC; runtime and
//! permission events are projected to the frontend shape (`agentic://<type>`,
//! `permission://event`) and pushed by the `serve` main loop as
//! `agent/frontendEvent` notifications.
//!
//! # Threat model (single-user local mode)
//!
//! This server targets a single-user, local-only deployment: one developer's
//! browser connecting to a loopback Server Host. There is **no per-connection
//! authentication, token exchange, or workspace/user/execution-domain binding**
//! yet. Every accepted connection can access the full agent kernel control
//! plane (sessions, turns, permissions, config, git). This is acceptable only
//! because the origin allow-list is fail-closed and the server is expected to
//! bind loopback. Multi-user, remote, or untrusted-network deployments require
//! connection-level authentication and scoped authorization that are **not**
//! implemented in this PR.

use axum::{
    extract::{
        ws::{WebSocket, WebSocketUpgrade},
        Extension, State,
    },
    http::{header::ORIGIN, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};

use openbitfun_app_server::OpenBitFunAppServer;

use crate::AppState;

/// Maximum accepted WS frame size (256 KiB), matching the prior envelope handler.
const MAX_WS_TEXT_BYTES: usize = 256 * 1024;

/// WebSocket connection handler.
///
/// Validates the browser origin, then upgrades the connection and runs one
/// in-process `OpenBitFunAppServer::serve` per connection over the WS-bridged
/// `Lines` transport.
pub(crate) async fn websocket_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Extension(openbitfun_app_server): Extension<OpenBitFunAppServer>,
    headers: HeaderMap,
) -> Response {
    if !browser_origin_allowed(&headers, &state) {
        tracing::warn!("Rejected WebSocket upgrade from untrusted browser origin");
        return StatusCode::FORBIDDEN.into_response();
    }
    tracing::info!("New WebSocket connection");
    ws.max_message_size(MAX_WS_TEXT_BYTES)
        .max_frame_size(MAX_WS_TEXT_BYTES)
        .on_upgrade(move |socket| handle_socket(socket, openbitfun_app_server))
}

/// Check the browser `Origin` header against the allow-list.
///
/// **Fail-closed**: a missing or unparsable `Origin` header is rejected. This
/// prevents non-browser clients (which do not send `Origin`) from silently
/// accessing the full runtime control plane. Only exact allow-list matches
/// pass. See the module-level threat-model note for the single-user local
/// deployment assumption.
fn browser_origin_allowed(headers: &HeaderMap, state: &AppState) -> bool {
    let Some(origin) = headers.get(ORIGIN) else {
        return false;
    };
    let Ok(origin) = origin.to_str() else {
        return false;
    };
    crate::normalize_browser_origin(origin)
        .is_ok_and(|origin| state.allowed_browser_origins.contains(&origin))
}

/// Run one in-process app-server over the WebSocket for the connection's life.
///
/// `OpenBitFunAppServer` is `Clone` (cheap Arc clone), so each connection gets its
/// own `serve` task; the shared `AgentRuntime` is internally synchronized, and
/// each connection subscribes independently to the runtime event/permission
/// streams. The task ends when the WS transport closes.
async fn handle_socket(socket: WebSocket, openbitfun_app_server: OpenBitFunAppServer) {
    tracing::info!("WebSocket connection established");
    let lines = super::ws_transport::ws_lines(socket);
    let result = openbitfun_app_server.serve(lines).await;
    match &result {
        Ok(()) => tracing::info!("WebSocket app-server connection ended cleanly"),
        Err(error) => tracing::warn!(
            error = ?error,
            "WebSocket app-server connection ended with error"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderMap;

    fn state_with_allowed_origins(origins: &[&str]) -> AppState {
        AppState {
            external_workspace_id: None,
            external_workspace_root: None,
            allowed_browser_origins: std::sync::Arc::new(
                origins.iter().map(|origin| (*origin).to_string()).collect(),
            ),
            dispatch_host: None,
        }
    }

    #[test]
    fn browser_origin_requires_an_exact_allowlist_match() {
        let state = state_with_allowed_origins(&["http://localhost:1422"]);
        let mut allowed_headers = HeaderMap::new();
        allowed_headers.insert(ORIGIN, "http://localhost:1422".parse().unwrap());
        assert!(browser_origin_allowed(&allowed_headers, &state));

        let mut unknown_headers = HeaderMap::new();
        unknown_headers.insert(ORIGIN, "https://example.test".parse().unwrap());
        assert!(!browser_origin_allowed(&unknown_headers, &state));
        // Missing Origin must be rejected (fail-closed).
        assert!(!browser_origin_allowed(&HeaderMap::new(), &state));
    }
}
