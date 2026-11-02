//! Shared Relay state and public health/capability metadata.
use crate::WebAssetStore;
use axum::extract::State;
use axum::Json;
use serde::Serialize;
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    pub start_time: std::time::Instant,
    pub asset_store: Arc<dyn WebAssetStore>,
    /// Every Relay host owns an authenticated account/device directory.
    pub db: Arc<crate::db::DbPool>,
    /// Optional per-page mutable data root (KV/SQLite/blobs). Required for Page Functions data plane.
    pub page_data: Option<crate::page_data::PageDataStore>,
    /// Page-scoped browser sessions issued after Relay account login. These
    /// stay process-local so no reusable account credential is persisted.
    pub page_access_manager: Arc<crate::routes::pages::PageAccessManager>,
    /// Manifest-bound Page draft upload sessions and per-Page serialization.
    pub page_upload_manager: Arc<crate::routes::pages::PageUploadManager>,
    /// Global/account/page admission control for public Page Function execution.
    pub page_execution_guard: Arc<crate::page_execution::PageExecutionGuard>,
    /// Per-IP rate limiter for auth endpoints (brute-force protection).
    pub login_rate_limiter: Arc<crate::routes::auth::LoginRateLimiter>,
    /// Per-user online device registry for account-based device routing.
    pub device_manager: Arc<crate::relay::DeviceManager>,
    /// Browser origins explicitly allowed to call this relay. An empty list
    /// means same-origin only; non-browser clients normally omit Origin.
    pub cors_allow_origins: Arc<Vec<String>>,
    /// Optional isolated browser origins for untrusted Page content and the
    /// trusted Relay account login UI.
    pub page_browser_auth: Option<Arc<crate::PageBrowserAuthConfig>>,
}

// ── Health & Info ──────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct HealthResponse {
    pub status: String,
    pub version: String,
    pub uptime_seconds: u64,
    pub account_features: bool,
    pub device_connections: usize,
    pub pending_device_rpcs: usize,
    pub asset_store_bytes: u64,
    pub asset_store_max_bytes: u64,
}

pub async fn health_check(State(state): State<AppState>) -> Json<HealthResponse> {
    health_check_for_host(State(state), env!("CARGO_PKG_VERSION")).await
}

pub(crate) async fn health_check_for_host(
    State(state): State<AppState>,
    host_version: &'static str,
) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "healthy".to_string(),
        version: host_version.to_string(),
        uptime_seconds: state.start_time.elapsed().as_secs(),
        account_features: true,
        device_connections: state.device_manager.connection_count(),
        pending_device_rpcs: state.device_manager.pending_rpc_count(),
        asset_store_bytes: state.asset_store.stored_bytes(),
        asset_store_max_bytes: state.asset_store.max_store_bytes(),
    })
}

#[derive(Serialize)]
pub struct ServerInfo {
    pub name: String,
    pub version: String,
    pub protocol_version: u8,
    pub capabilities: Vec<&'static str>,
}

pub async fn server_info() -> Json<ServerInfo> {
    server_info_for_host(env!("CARGO_PKG_VERSION")).await
}

pub(crate) async fn server_info_for_host(host_version: &'static str) -> Json<ServerInfo> {
    Json(ServerInfo {
        name: "OpenBitFun Relay Server".to_string(),
        version: host_version.to_string(),
        protocol_version: 3,
        capabilities: vec![
            "device_alias_v1",
            "device_metadata_v1",
            "device_client_build_v1",
            // Hosts may report themselves as `cli` instead of `desktop`.
            // Clients must ask before using it: an older Relay rejects the
            // unknown kind outright, which would fail the whole login.
            "device_kind_cli_v1",
        ],
    })
}
