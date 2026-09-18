// The app-server's `Builder::on_receive_request(...)` chain monomorphizes
// into a deeply nested `ChainedHandler<ChainedHandler<…>>` (~20 request
// handlers plus a dispatch handler). Computing the resulting connection
// future's layout pushes the trait solver past the default 128 limit, so bump
// it. Matches the compiler's own suggestion in the overflow diagnostic.
#![recursion_limit = "256"]

//! Loopback Web Server and App Server Host entrypoint.
//!
//! The host owns one embedded ProductFull Agent Runtime and exposes it through
//! the in-process App Server. Local workspace mutations remain gated by Core
//! Runtime ownership. This is a loopback, single-user compatibility surface;
//! it does not claim a remote, multi-user, or public Server Agent API.

use anyhow::Result;
/// OpenBitFun Server
///
/// Web server with support for:
/// - RESTful API
/// - WebSocket real-time communication
/// - Static file serving (frontend)
use axum::{
    http::{HeaderValue, Method, Uri},
    routing::get,
    Json, Router,
};
use clap::Parser;
use serde::Serialize;
use std::{collections::HashSet, net::SocketAddr, path::PathBuf, sync::Arc};
use tower_http::cors::CorsLayer;

mod app_server;
mod bootstrap;
mod routes;

pub(crate) struct DispatchHostState {
    path_manager: Arc<openbitfun_core::infrastructure::PathManager>,
    ssh_manager: Arc<openbitfun_core::service::remote_ssh::SSHConnectionManager>,
}

/// Application state
#[derive(Clone)]
pub struct AppState {
    // NOTE(Step 2a): only read by the external_sources dispatch path, which is
    // temporarily dead under browser-direct ACP-over-WS. Kept for the follow-up
    // that brings external_sources onto the app-server schema.
    #[allow(dead_code)]
    external_workspace_id: Option<String>,
    /// Canonical root of the owned workspace. Only used to upgrade legacy
    /// `workspacePath` requests to the owned workspace ID; never an identity.
    #[allow(dead_code)]
    external_workspace_root: Option<PathBuf>,
    allowed_browser_origins: Arc<HashSet<String>>,
    dispatch_host: Option<Arc<DispatchHostState>>,
}

const DEFAULT_ALLOWED_BROWSER_ORIGINS: [&str; 2] =
    ["http://localhost:1422", "http://127.0.0.1:1422"];

#[derive(Debug, Parser)]
#[command(name = "openbitfun-server")]
struct ServerArgs {
    /// Initial local workspace opened when this Server Host starts.
    #[arg(long, value_name = "PATH")]
    workspace: Option<PathBuf>,

    /// Browser origin allowed to connect to this Server Host. Repeat to allow more than one.
    /// When omitted, only OpenBitFun's local Web development origins are allowed.
    #[arg(long = "allowed-origin", value_name = "ORIGIN")]
    allowed_origins: Vec<String>,
}

/// Health check response
#[derive(Serialize)]
struct HealthResponse {
    status: String,
    version: String,
    uptime_seconds: u64,
}

/// Health check handler
async fn health_check() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "healthy".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        uptime_seconds: 0,
    })
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .init();

    tracing::info!("OpenBitFun Server v{}", env!("CARGO_PKG_VERSION"));
    openbitfun_core::service::remote_connect::ensure_rustls_crypto_provider();

    let args = ServerArgs::parse();
    let external_workspace_root = args
        .workspace
        .map(|path| {
            if !path.is_absolute() {
                return Err(anyhow::anyhow!("--workspace must be an absolute path"));
            }
            path.canonicalize()
                .map_err(|error| anyhow::anyhow!("Could not open Server workspace: {error}"))
        })
        .transpose()?;

    // Initialize the full agentic stack (coordinator, scheduler, token usage,
    // MCP/config/filesystem services, event queue). This binding is held alive
    // for the lifetime of the server so its services outlive every websocket
    // connection; the app-server client and spawned tasks hold their own Arc
    // clones of the coordinator, scheduler, and event queue.
    let server_state = bootstrap::initialize(
        external_workspace_root
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned()),
    )
    .await?;

    // Build the agent runtime the same way the Desktop session application does,
    // then build an in-process `OpenBitFunAppServer` for it. Each WebSocket
    // connection is handed straight to `OpenBitFunAppServer::serve` over a WS-bridged
    // `Lines` transport (browser-direct ACP-over-WS, Step 2), so the browser
    // connects directly to the in-process app-server over native JSON-RPC — no
    // shared in-process client, no custom WS envelope.
    let agent_runtime =
        openbitfun_core::product_runtime::CoreProductAgentRuntime::build_session_surface(
            server_state.coordinator.clone(),
            server_state.scheduler.clone(),
            server_state.token_usage_service.clone(),
        )
        .map_err(|error| anyhow::anyhow!("Failed to build agent runtime: {error}"))?;
    // The product owner keeps the legacy queue drained while each connection's
    // `serve` loop independently subscribes to and projects Runtime events.
    let event_source = server_state.agent_event_queue_owner.runtime_source();
    let product_search = Arc::new(
        openbitfun_core::product_runtime::CoreAgentRuntimeCompatibility::build(
            server_state.coordinator.clone(),
            server_state.scheduler.clone(),
        ),
    );
    let openbitfun_app_server = app_server::build(agent_runtime, event_source, product_search);

    tracing::info!(
        "App-server ready; each WebSocket connection drives one in-process serve over native JSON-RPC"
    );

    let configured_origins = if args.allowed_origins.is_empty() {
        DEFAULT_ALLOWED_BROWSER_ORIGINS
            .iter()
            .map(|origin| (*origin).to_string())
            .collect()
    } else {
        args.allowed_origins
    };
    let allowed_browser_origins = configured_origins
        .iter()
        .map(|origin| normalize_browser_origin(origin))
        .collect::<Result<HashSet<_>>>()?;
    let cors_origins = allowed_browser_origins
        .iter()
        .map(|origin| {
            HeaderValue::from_str(origin)
                .map_err(|_| anyhow::anyhow!("--allowed-origin contains an invalid header value"))
        })
        .collect::<Result<Vec<_>>>()?;

    // Detached dispatch remains a narrow controller/observer capability beside
    // the host-owned Agent Runtime. It keeps its SSH/process state separate and
    // does not construct another Agent Runtime or widen the App Server scope.
    let path_manager = Arc::new(openbitfun_core::infrastructure::PathManager::new()?);
    let ssh_data_dir = dirs::data_local_dir()
        .ok_or_else(|| anyhow::anyhow!("Could not resolve the local data directory"))?
        .join("OpenBitFun")
        .join("ssh");
    let ssh_manager =
        Arc::new(openbitfun_core::service::remote_ssh::SSHConnectionManager::new(ssh_data_dir));
    if let Err(error) = ssh_manager.load_saved_connections().await {
        tracing::warn!(error = %error, "Failed to load saved SSH connections");
    }
    if let Err(error) = ssh_manager.load_known_hosts().await {
        tracing::warn!(error = %error, "Failed to load SSH known hosts");
    }
    // The Server Host's project workspace is the record bootstrap activated;
    // external-source requests are scoped to it by workspace ID.
    let external_workspace_id = server_state
        .initial_workspace
        .as_ref()
        .map(|workspace| workspace.id.clone());
    let external_workspace_root = server_state
        .initial_workspace
        .as_ref()
        .map(|workspace| {
            workspace
                .root_path
                .canonicalize()
                .unwrap_or_else(|_| workspace.root_path.clone())
        })
        .or(external_workspace_root);
    let app_state = AppState {
        external_workspace_id,
        external_workspace_root,
        allowed_browser_origins: Arc::new(allowed_browser_origins),
        dispatch_host: Some(Arc::new(DispatchHostState {
            path_manager,
            ssh_manager,
        })),
    };

    let app = Router::new()
        .route("/health", get(health_check))
        .route("/api/v1/health", get(health_check))
        .route("/api/v1/info", get(routes::api::api_info))
        .route("/ws", get(routes::websocket::websocket_handler))
        .layer(
            CorsLayer::new()
                .allow_methods([Method::GET])
                .allow_origin(cors_origins),
        )
        // The OpenBitFunAppServer is cloned per WebSocket connection through an axum
        // Extension (cheap Arc clone); each connection spawns its own `serve`
        // over a WS-bridged `Lines` transport.
        .layer(axum::Extension(openbitfun_app_server))
        .with_state(app_state);

    let addr = SocketAddr::from(([127, 0, 0, 1], 8080));
    tracing::info!("Server started: http://{}", addr);
    tracing::info!("WebSocket endpoint: ws://{}/ws", addr);
    tracing::info!("Health check: http://{}/health", addr);
    tracing::info!(
        allowed_origin_count = configured_origins.len(),
        "Browser origin policy configured"
    );

    let listener = tokio::net::TcpListener::bind(addr).await?;
    let server = axum::serve(listener, app).with_graceful_shutdown(async {
        if let Err(error) = tokio::signal::ctrl_c().await {
            tracing::error!(error = %error, "Failed to listen for Server shutdown signal");
        }
    });
    let serve_result = server.await;
    let shutdown_result = openbitfun_core::plugin_host::shutdown_configured_plugin_host().await;
    serve_result?;
    shutdown_result?;

    Ok(())
}

pub(crate) fn normalize_browser_origin(value: &str) -> Result<String> {
    let trimmed = value.trim();
    let uri = trimmed
        .parse::<Uri>()
        .map_err(|_| anyhow::anyhow!("--allowed-origin must be an HTTP or HTTPS origin"))?;
    let scheme = uri
        .scheme_str()
        .filter(|scheme| {
            scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https")
        })
        .ok_or_else(|| anyhow::anyhow!("--allowed-origin must use http or https"))?;
    let authority = uri
        .authority()
        .ok_or_else(|| anyhow::anyhow!("--allowed-origin must include a host"))?;
    if uri
        .path_and_query()
        .is_some_and(|path_and_query| path_and_query.as_str() != "/")
    {
        return Err(anyhow::anyhow!(
            "--allowed-origin must not include a path, query, or fragment"
        ));
    }
    Ok(format!("{scheme}://{authority}").to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_origins_are_normalized_for_exact_matching() {
        assert_eq!(
            normalize_browser_origin(" HTTPS://Example.TEST:8443/ ").unwrap(),
            "https://example.test:8443"
        );
    }

    #[test]
    fn browser_origins_reject_non_origins() {
        for invalid in [
            "file:///tmp/index.html",
            "https://example.test/app",
            "https://example.test?mode=web",
            "example.test",
        ] {
            assert!(normalize_browser_origin(invalid).is_err(), "{invalid}");
        }
    }
}
