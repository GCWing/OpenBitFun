//! Desktop-owned embedded relay host for LAN Remote Connect modes.

use log::{info, warn};
use openbitfun_core::service::remote_connect::embedded_relay_host::EmbeddedRelayHost;
use openbitfun_relay_service::{build_relay_router, MemoryAssetStore};
use std::sync::Arc;
use tokio::sync::Mutex;

const SHUTDOWN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

#[derive(Default)]
pub(crate) struct DesktopEmbeddedRelayHost {
    runtime: Mutex<Option<EmbeddedRelayRuntime>>,
    #[cfg(test)]
    start_candidate_ready: tokio::sync::Notify,
}

struct EmbeddedRelayRuntime {
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    server_task: Option<tokio::task::JoinHandle<()>>,
}

impl EmbeddedRelayRuntime {
    fn signal_shutdown(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
    }

    async fn stop(mut self) {
        self.signal_shutdown();

        if let Some(mut server_task) = self.server_task.take() {
            match tokio::time::timeout(SHUTDOWN_TIMEOUT, &mut server_task).await {
                Ok(Ok(())) => {}
                Ok(Err(error)) if error.is_cancelled() => {}
                Ok(Err(error)) => {
                    warn!("Embedded relay server task failed during shutdown: {error}");
                }
                Err(_) => {
                    warn!("Embedded relay shutdown timed out; aborting server task");
                    server_task.abort();
                    let _ = server_task.await;
                }
            }
        }

        info!("Embedded relay stopped");
    }

    fn abort(&mut self) {
        self.signal_shutdown();
        if let Some(server_task) = self.server_task.take() {
            server_task.abort();
        }
    }
}

impl Drop for EmbeddedRelayRuntime {
    fn drop(&mut self) {
        self.abort();
    }
}

impl Drop for DesktopEmbeddedRelayHost {
    fn drop(&mut self) {
        if let Some(mut runtime) = self.runtime.get_mut().take() {
            runtime.abort();
        }
    }
}

#[async_trait::async_trait]
impl EmbeddedRelayHost for DesktopEmbeddedRelayHost {
    async fn start(&self, port: u16, static_dir: Option<String>) -> anyhow::Result<()> {
        let mut runtime = self.runtime.lock().await;
        if runtime.is_some() {
            anyhow::bail!("embedded relay is already running");
        }

        let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{port}"))
            .await
            .map_err(|error| {
                anyhow::anyhow!("failed to bind embedded relay on port {port}: {error}")
            })?;

        // Each locally hosted Relay owns its account directory and credentials,
        // using exactly the same database schema and router as the official host.
        #[cfg(not(test))]
        let database_path = {
            let root = std::env::var_os("OPENBITFUN_HOME")
                .or_else(|| std::env::var_os("OPENBITFUN_E2E_HOME"))
                .map(std::path::PathBuf::from)
                .filter(|path| !path.as_os_str().is_empty())
                .or_else(|| {
                    dirs::home_dir().map(|home| {
                        home.join(openbitfun_core_types::product_identity::hidden_data_directory())
                    })
                })
                .ok_or_else(|| {
                    anyhow::anyhow!("Cannot determine product home for the local Relay")
                })?;
            let directory = root.join("relay-v1.0.0").join("local-server");
            tokio::fs::create_dir_all(&directory).await?;
            directory.join("relay.db").to_string_lossy().into_owned()
        };
        #[cfg(test)]
        let database_path = ":memory:".to_string();
        let database = Arc::new(openbitfun_relay_service::db::connect(&database_path).await?);
        let asset_store = Arc::new(MemoryAssetStore::new());
        let start_time = std::time::Instant::now();

        let mut app =
            build_relay_router(asset_store, start_time, database, env!("CARGO_PKG_VERSION"));

        if let Some(dir) = static_dir.as_deref() {
            info!("Embedded relay: serving static files from {dir}");
            let serve_dir =
                tower_http::services::ServeDir::new(dir).append_index_html_on_directories(true);
            let static_app = axum::Router::<()>::new()
                .fallback_service(serve_dir)
                .layer(axum::middleware::from_fn(static_cache_headers));
            app = app.fallback_service(static_app);
        }
        app = app.layer(axum::middleware::from_fn(
            openbitfun_relay_service::relay_security_headers,
        ));

        info!("Embedded relay started on 0.0.0.0:{port}");

        let (shutdown, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
        let server_task = tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            })
            .await
            .ok();
        });

        // Keep the candidate local until readiness completes. If the start
        // future is cancelled, Drop aborts the server task and releases the bound
        // listener instead of leaving a hidden active runtime in the host.
        let candidate = EmbeddedRelayRuntime {
            shutdown: Some(shutdown),
            server_task: Some(server_task),
        };

        #[cfg(test)]
        self.start_candidate_ready.notify_one();

        // Preserve the existing readiness grace period before product
        // orchestration connects the local relay WebSocket.
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;

        *runtime = Some(candidate);

        Ok(())
    }

    async fn stop(&self) {
        let runtime = self.runtime.lock().await.take();
        if let Some(runtime) = runtime {
            runtime.stop().await;
        }
    }
}

async fn static_cache_headers(
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let path = request.uri().path().to_string();
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    if path == "/" || path.ends_with(".html") {
        headers.insert(
            axum::http::header::CACHE_CONTROL,
            axum::http::HeaderValue::from_static("no-cache, no-store, must-revalidate"),
        );
        headers.insert(
            axum::http::header::PRAGMA,
            axum::http::HeaderValue::from_static("no-cache"),
        );
    } else if path.starts_with("/assets/") {
        headers.insert(
            axum::http::header::CACHE_CONTROL,
            axum::http::HeaderValue::from_static("public, max-age=31536000, immutable"),
        );
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::header::{CACHE_CONTROL, PRAGMA};

    async fn unused_port() -> u16 {
        let listener = tokio::net::TcpListener::bind("0.0.0.0:0")
            .await
            .expect("test should reserve an unused port");
        listener
            .local_addr()
            .expect("reserved listener should have an address")
            .port()
    }

    /// Assert `port` became bindable again, i.e. the host really did drop its
    /// listener.
    ///
    /// A single bind attempt conflates two different things: our host leaking
    /// the listener, and some other socket on the machine transiently holding
    /// the port — it came from the ephemeral range, so a busy test run reissues
    /// it constantly. Retrying separates them: a leaked listener is held until
    /// the process exits and never frees up, while a transient steal clears in
    /// milliseconds.
    async fn assert_port_released(port: u16, what: &str) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let last_err = match tokio::net::TcpListener::bind(("0.0.0.0", port)).await {
                Ok(l) => {
                    drop(l);
                    return;
                }
                Err(e) => e,
            };
            if std::time::Instant::now() >= deadline {
                panic!("{what}: port {port} never became bindable again: {last_err:?}");
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    }

    /// Start `host` on a port nothing else has taken, returning that port.
    ///
    /// `unused_port` can only report a port that was free a moment ago: it
    /// binds an ephemeral port, reads the number and drops the listener, so
    /// anything else on the machine may claim it before the caller binds. A
    /// single attempt is a race that stays invisible on a quiet machine and
    /// fails most of the time when the rest of the suite is busy enough to
    /// churn through ephemeral ports. Retry rather than assume.
    async fn start_on_free_port(
        host: &DesktopEmbeddedRelayHost,
        static_dir: Option<String>,
    ) -> u16 {
        let mut last_err = String::new();
        for _ in 0..16 {
            let port = unused_port().await;
            match host.start(port, static_dir.clone()).await {
                Ok(()) => return port,
                Err(e) => last_err = e.to_string(),
            }
        }
        panic!("could not find a free port for the embedded relay: {last_err}");
    }

    /// Restart on the same port while tolerating a transient claim from another
    /// socket in the runner's ephemeral range. A leaked relay listener never
    /// becomes bindable and therefore still fails at the deadline.
    async fn restart_on_same_port(
        host: &DesktopEmbeddedRelayHost,
        port: u16,
        static_dir: Option<String>,
    ) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            match host.start(port, static_dir.clone()).await {
                Ok(()) => return,
                Err(error) => {
                    if std::time::Instant::now() >= deadline {
                        panic!(
                            "embedded relay could not restart on port {port} after it was stopped: {error}"
                        );
                    }
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    }

    #[tokio::test]
    async fn bind_failure_does_not_create_an_active_runtime() {
        let occupied = tokio::net::TcpListener::bind("0.0.0.0:0")
            .await
            .expect("test should occupy a port");
        let port = occupied
            .local_addr()
            .expect("occupied listener should have an address")
            .port();
        let host = DesktopEmbeddedRelayHost::default();

        let error = host
            .start(port, None)
            .await
            .expect_err("starting on an occupied port should fail");

        assert!(error
            .to_string()
            .starts_with(&format!("failed to bind embedded relay on port {port}:")));
        assert!(host.runtime.lock().await.is_none());
    }

    #[tokio::test]
    async fn static_cache_headers_and_listener_lifecycle_are_preserved() {
        let static_dir = std::env::temp_dir().join(format!(
            "openbitfun-embedded-relay-host-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(static_dir.join("assets"))
            .expect("test static directory should be created");
        std::fs::write(static_dir.join("index.html"), "embedded relay test")
            .expect("test index should be written");
        std::fs::write(static_dir.join("assets").join("app.js"), "test asset")
            .expect("test asset should be written");

        let host = DesktopEmbeddedRelayHost::default();
        let port = start_on_free_port(&host, Some(static_dir.to_string_lossy().into_owned())).await;

        crate::ensure_rustls_crypto_provider();
        let client = reqwest::Client::new();
        let index = client
            .get(format!("http://127.0.0.1:{port}/"))
            .send()
            .await
            .expect("index request should complete");
        assert!(index.status().is_success());
        assert_eq!(
            index
                .headers()
                .get(CACHE_CONTROL)
                .and_then(|v| v.to_str().ok()),
            Some("no-cache, no-store, must-revalidate")
        );
        assert_eq!(
            index.headers().get(PRAGMA).and_then(|v| v.to_str().ok()),
            Some("no-cache")
        );

        let asset = client
            .get(format!("http://127.0.0.1:{port}/assets/app.js"))
            .send()
            .await
            .expect("asset request should complete");
        assert!(asset.status().is_success());
        assert_eq!(
            asset
                .headers()
                .get(CACHE_CONTROL)
                .and_then(|v| v.to_str().ok()),
            Some("public, max-age=31536000, immutable")
        );

        drop(index);
        drop(asset);
        drop(client);
        host.stop().await;

        restart_on_same_port(&host, port, Some(static_dir.to_string_lossy().into_owned())).await;
        host.stop().await;

        assert_port_released(port, "stop must release the listener before returning").await;
        std::fs::remove_dir_all(&static_dir).expect("test static directory should be removed");
    }

    #[tokio::test]
    async fn cancelled_start_releases_listener_without_committing_runtime() {
        // Same port race as `start_on_free_port`, but this test aborts `start`
        // mid-flight and so cannot use its success as the signal: a port stolen
        // between reservation and bind shows up here as readiness never firing.
        // Retry until we get a port `start` could actually take.
        let host = Arc::new(DesktopEmbeddedRelayHost::default());
        let mut acquired: Option<(u16, tokio::task::JoinHandle<_>)> = None;
        for _ in 0..16 {
            let port = unused_port().await;
            let start_task = tokio::spawn({
                let host = host.clone();
                async move { host.start(port, None).await }
            });
            if tokio::time::timeout(
                std::time::Duration::from_secs(1),
                host.start_candidate_ready.notified(),
            )
            .await
            .is_ok()
            {
                acquired = Some((port, start_task));
                break;
            }
            start_task.abort();
            let _ = start_task.await;
        }
        let (port, start_task) =
            acquired.expect("start should create the candidate runtime before readiness completes");

        start_task.abort();
        let _ = start_task.await;

        assert!(host.runtime.lock().await.is_none());
        assert_port_released(port, "cancelling start must release the listener").await;
    }
}
