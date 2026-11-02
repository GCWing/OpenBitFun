//! Browser control integration services.
//!
//! This module owns platform browser detection, CDP endpoint HTTP handling, and
//! CDP launch process handling.
//! Product policy, tool routing, and UI commands stay in product assembly and
//! app entrypoints.

pub mod cdp;
pub mod launcher;

pub use cdp::{CdpEndpointError, CdpEndpointProvider, CdpPageInfo, CdpVersionInfo};
pub use launcher::{
    BrowserDebugEndpoint, BrowserKind, BrowserLaunchOptions, BrowserLauncher, CdpPortProbe,
    LaunchResult, DEFAULT_CDP_PORT, GUARDED_BROWSER_WEBSOCKET_PATH,
};

#[cfg(test)]
pub(crate) mod test_support {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// Loopback HTTP server that answers every request with one fixed status
    /// line and body, like a guarded Chromium endpoint answering `/json*`
    /// with an empty 404. Returns the bound port.
    pub(crate) async fn serve_fixed_http(status: &'static str, body: &'static str) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                tokio::spawn(async move {
                    let mut buffer = [0_u8; 4096];
                    let _ = socket.read(&mut buffer).await;
                    let response = format!(
                        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = socket.write_all(response.as_bytes()).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        port
    }

    /// A loopback port with nothing listening on it.
    pub(crate) fn closed_port() -> u16 {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        listener.local_addr().expect("addr").port()
    }
}
