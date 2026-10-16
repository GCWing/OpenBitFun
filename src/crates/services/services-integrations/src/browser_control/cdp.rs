//! Browser CDP HTTP endpoint provider.
//!
//! The WebSocket protocol client stays in the product facade for now because
//! it is tightly coupled to browser session state. HTTP endpoint probing and
//! page creation are concrete network behavior and belong in services.

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Information about a single browser page/tab from the CDP `/json` endpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CdpPageInfo {
    pub id: String,
    pub title: String,
    pub url: String,
    #[serde(rename = "webSocketDebuggerUrl")]
    pub web_socket_debugger_url: Option<String>,
    #[serde(rename = "type")]
    pub page_type: Option<String>,
}

/// Version info returned by `/json/version`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CdpVersionInfo {
    /// Modern headless Chrome reports a regular product name; its UA retains
    /// the HeadlessChrome token. Older endpoints may omit this field.
    #[serde(
        rename = "User-Agent",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub user_agent: Option<String>,
    #[serde(rename = "Browser")]
    pub browser: Option<String>,
    #[serde(rename = "Protocol-Version")]
    pub protocol_version: Option<String>,
    #[serde(rename = "webSocketDebuggerUrl")]
    pub web_socket_debugger_url: Option<String>,
}

#[derive(Debug, Error)]
pub enum CdpEndpointError {
    #[error("Cannot reach browser CDP on port {port}: {message}")]
    VersionRequest { port: u16, message: String },
    #[error("Invalid CDP version response: {0}")]
    VersionResponse(String),
    #[error("Cannot list CDP pages on port {port}: {message}")]
    ListPagesRequest { port: u16, message: String },
    #[error("Invalid CDP pages response: {0}")]
    ListPagesResponse(String),
    #[error("Cannot create CDP page on port {port}: {message}")]
    CreatePageRequest { port: u16, message: String },
    #[error("Invalid CDP new page response: {0}")]
    CreatePageResponse(String),
}

pub struct CdpEndpointProvider;

impl CdpEndpointProvider {
    /// Discover browser version on the given debug port.
    pub async fn get_version(port: u16) -> Result<CdpVersionInfo, CdpEndpointError> {
        let url = format!("http://127.0.0.1:{}/json/version", port);
        let resp = crate::reqwest_client()
            .get(&url)
            .send()
            .await
            .map_err(|source| CdpEndpointError::VersionRequest {
                port,
                message: source.to_string(),
            })?;
        resp.json()
            .await
            .map_err(|source| CdpEndpointError::VersionResponse(source.to_string()))
    }

    /// List all pages/tabs on the given debug port.
    pub async fn list_pages(port: u16) -> Result<Vec<CdpPageInfo>, CdpEndpointError> {
        let url = format!("http://127.0.0.1:{}/json", port);
        let resp = crate::reqwest_client()
            .get(&url)
            .send()
            .await
            .map_err(|source| CdpEndpointError::ListPagesRequest {
                port,
                message: source.to_string(),
            })?;
        resp.json()
            .await
            .map_err(|source| CdpEndpointError::ListPagesResponse(source.to_string()))
    }

    /// Create a new page/tab on the given debug port.
    pub async fn create_page(
        port: u16,
        url: Option<&str>,
    ) -> Result<CdpPageInfo, CdpEndpointError> {
        let endpoint = if let Some(url) = url {
            let encoded = url.replace(' ', "%20");
            format!("http://127.0.0.1:{}/json/new?{}", port, encoded)
        } else {
            format!("http://127.0.0.1:{}/json/new", port)
        };
        let resp = crate::reqwest_client()
            .put(&endpoint)
            .send()
            .await
            .map_err(|source| CdpEndpointError::CreatePageRequest {
                port,
                message: source.to_string(),
            })?;
        resp.json()
            .await
            .map_err(|source| CdpEndpointError::CreatePageResponse(source.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cdp_page_info_preserves_websocket_debugger_field() {
        let page: CdpPageInfo = serde_json::from_value(serde_json::json!({
            "id": "page-1",
            "title": "Example",
            "url": "https://example.com",
            "webSocketDebuggerUrl": "ws://127.0.0.1/devtools/page/page-1",
            "type": "page"
        }))
        .expect("page info should deserialize");

        assert_eq!(
            page.web_socket_debugger_url.as_deref(),
            Some("ws://127.0.0.1/devtools/page/page-1")
        );
        assert_eq!(page.page_type.as_deref(), Some("page"));
    }

    #[test]
    fn cdp_version_info_preserves_browser_and_protocol_fields() {
        let version: CdpVersionInfo = serde_json::from_value(serde_json::json!({
            "Browser": "Chrome/130",
            "Protocol-Version": "1.3",
            "webSocketDebuggerUrl": "ws://127.0.0.1/devtools/browser"
        }))
        .expect("version info should deserialize");

        assert!(version.user_agent.is_none());
        let roundtrip = serde_json::to_value(&version).unwrap();
        assert!(roundtrip.get("User-Agent").is_none());
        let old_again: CdpVersionInfo = serde_json::from_value(roundtrip).unwrap();
        assert_eq!(old_again.browser, version.browser);
        assert_eq!(version.browser.as_deref(), Some("Chrome/130"));
        assert_eq!(version.protocol_version.as_deref(), Some("1.3"));
        assert_eq!(
            version.web_socket_debugger_url.as_deref(),
            Some("ws://127.0.0.1/devtools/browser")
        );
    }
}
