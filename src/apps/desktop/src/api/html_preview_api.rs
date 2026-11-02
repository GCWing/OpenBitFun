//! Controller-owned HTTP gateway for workspace HTML, including SSH and peer hosts.

use crate::api::app_state::AppState;
use crate::api::remote_connect_api::{
    account_context_generation, account_context_is_current, account_device_rpc,
};
use axum::{
    body::Body,
    extract::State,
    http::{header, HeaderMap, Method, StatusCode, Uri},
    response::Response,
    routing::any,
    Router,
};
use futures::TryStreamExt;
use openbitfun_core::service::filesystem::html_preview::resolve_html_preview_source;
use openbitfun_product_domains::{
    html_preview::{
        HtmlPreviewError, HtmlPreviewErrorCode as Code, HtmlPreviewResource,
        HtmlPreviewResourceReply, HtmlPreviewResourceRequest,
    },
    remote_surface::PeerHostCapability,
};
use openbitfun_services_integrations::remote_connect::{
    html_preview::transfer::{HtmlPreviewReader as PreviewReader, HtmlPreviewTransfer},
    RemoteCommand, RemoteResponse,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::{net::TcpListener, sync::watch};
use uuid::Uuid;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HtmlPreviewCreateRequest {
    pub file_path: String,
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// Temporary pre-ID wire fields; current clients send workspaceId.
    #[serde(default)]
    pub workspace_path: String,
    #[serde(default)]
    pub remote_connection_id: Option<String>,
    #[serde(default)]
    pub peer_device_mode: bool,
    #[serde(default)]
    pub peer_device_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HtmlPreviewCreateResponse {
    pub url: String,
    pub session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HtmlPreviewReleaseRequest {
    pub session_id: String,
}

struct PeerPreviewReader {
    device_id: String,
    account_generation: u64,
}

impl PeerPreviewReader {
    async fn invoke(
        &self,
        command: &str,
        args: serde_json::Value,
    ) -> Result<serde_json::Value, HtmlPreviewError> {
        if !self.is_current() {
            return Err(HtmlPreviewError::unavailable(
                "HTML preview account changed; reopen the preview",
            ));
        }
        let command = serde_json::to_string(&RemoteCommand::HostInvoke {
            command: command.to_string(),
            args,
        })
        .map_err(|error| HtmlPreviewError::unavailable(error.to_string()))?;
        let raw = account_device_rpc(self.device_id.clone(), command, None)
            .await
            .map_err(HtmlPreviewError::unavailable)?;
        if !self.is_current() {
            return Err(HtmlPreviewError::unavailable(
                "HTML preview account changed; reopen the preview",
            ));
        }
        decode_peer_result(&raw)
    }

    async fn ensure_supported(&self) -> Result<(), HtmlPreviewError> {
        let ping = self.invoke("peer_mode_ping", serde_json::json!({})).await?;
        require_preview_capability(&ping)
    }
}

fn require_preview_capability(ping: &serde_json::Value) -> Result<(), HtmlPreviewError> {
    if ping
        .get("capabilities")
        .and_then(|caps| caps.get(PeerHostCapability::WorkspaceHtmlPreviewV1.key()))
        .and_then(serde_json::Value::as_bool)
        != Some(true)
    {
        return Err(HtmlPreviewError::unavailable("This device does not support HTML preview resources; update OpenBitFun on the controlled device"));
    }
    Ok(())
}

fn decode_peer_result(raw: &str) -> Result<serde_json::Value, HtmlPreviewError> {
    match serde_json::from_str::<RemoteResponse>(raw)
        .map_err(|_| HtmlPreviewError::unavailable("Invalid peer HTML preview response"))?
    {
        RemoteResponse::HostInvokeResult {
            ok: true,
            value: Some(value),
            ..
        } => Ok(value),
        RemoteResponse::HostInvokeResult { error, .. } => Err(HtmlPreviewError::unavailable(
            error.unwrap_or_else(|| "Peer HTML preview failed".into()),
        )),
        RemoteResponse::Error { message } => Err(HtmlPreviewError::unavailable(message)),
        _ => Err(HtmlPreviewError::unavailable(
            "Invalid peer HTML preview response",
        )),
    }
}

#[async_trait::async_trait]
impl PreviewReader for PeerPreviewReader {
    fn is_current(&self) -> bool {
        account_context_is_current(self.account_generation)
    }
    async fn read(
        &self,
        request: &HtmlPreviewResourceRequest,
    ) -> Result<HtmlPreviewResource, HtmlPreviewError> {
        let value = self
            .invoke(
                "html_preview_read_resource",
                serde_json::json!({ "request": request }),
            )
            .await?;
        serde_json::from_value::<HtmlPreviewResourceReply>(value)
            .map_err(|_| HtmlPreviewError::unavailable("Invalid peer HTML preview resource"))?
            .into_result()
    }
}

#[derive(Clone)]
struct PreviewState {
    token: String,
    cookie_name: String,
    entry_path: String,
    request: HtmlPreviewResourceRequest,
    transfer: Arc<HtmlPreviewTransfer>,
    closed: watch::Receiver<bool>,
}

static SESSIONS: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<String, watch::Sender<bool>>>,
> = std::sync::OnceLock::new();
fn sessions() -> &'static std::sync::Mutex<std::collections::HashMap<String, watch::Sender<bool>>> {
    SESSIONS.get_or_init(Default::default)
}

#[tauri::command]
pub async fn html_preview_create(
    app_state: tauri::State<'_, AppState>,
    request: HtmlPreviewCreateRequest,
) -> Result<HtmlPreviewCreateResponse, String> {
    let is_peer = request.peer_device_mode
        || request.peer_device_id.is_some()
        || super::peer_host_invoke::is_peer_controller_active();
    let reader: Arc<dyn PreviewReader>;
    let workspace_id;
    if is_peer {
        let device_id = request
            .peer_device_id
            .filter(|id| !id.trim().is_empty())
            .ok_or("HTML preview requires the selected peer device identity; reopen the file")?;
        workspace_id = request
            .workspace_id
            .filter(|id| !id.trim().is_empty())
            .ok_or("HTML preview workspace ID is required")?;
        let peer = PeerPreviewReader {
            device_id,
            account_generation: account_context_generation(),
        };
        peer.ensure_supported()
            .await
            .map_err(|error| error.message)?;
        reader = Arc::new(peer);
    } else {
        workspace_id = match request.workspace_id {
            Some(id) => id,
            None => {
                app_state
                    .workspace_service
                    .resolve_legacy_workspace_reference(
                        None,
                        &request.workspace_path,
                        request.remote_connection_id.as_deref(),
                        None,
                    )
                    .await
                    .map_err(|error| error.to_string())?
                    .ok_or("HTML preview workspace is unavailable")?
                    .id
            }
        };
        reader = Arc::new(
            resolve_html_preview_source(&workspace_id, &request.file_path)
                .await
                .map_err(|error| error.message)?,
        );
    }
    start_preview(
        reader,
        HtmlPreviewResourceRequest {
            workspace_id,
            file_path: request.file_path,
            resource_path: None,
            metadata_only: true,
            offset: 0,
            expected_source: None,
            expected_revision: None,
        },
    )
    .await
}

/// Runs on the workspace owner. Desktop and CLI use the same assembly/service path.
#[tauri::command]
pub async fn html_preview_read_resource(
    request: HtmlPreviewResourceRequest,
) -> HtmlPreviewResourceReply {
    openbitfun_core::service::filesystem::html_preview::html_preview_read_resource(request).await
}

async fn start_preview(
    reader: Arc<dyn PreviewReader>,
    mut request: HtmlPreviewResourceRequest,
) -> Result<HtmlPreviewCreateResponse, String> {
    let (shutdown, closed) = watch::channel(false);
    let transfer = Arc::new(HtmlPreviewTransfer::new(reader, closed.clone()));
    let entry = transfer
        .open(request.clone(), false, None)
        .await
        .map_err(|error| error.message)?
        .metadata;
    request.expected_source = Some(entry.source);
    let token = Uuid::new_v4().simple().to_string();
    let session_id = Uuid::new_v4().simple().to_string();
    let state = PreviewState {
        token: token.clone(),
        cookie_name: format!("openbitfun_html_preview_{session_id}"),
        entry_path: entry.entry_path,
        request,
        transfer,
        closed: closed.clone(),
    };
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|error| format!("Failed to bind HTML preview server: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    let router = Router::new()
        .fallback(any(preview_handler))
        .with_state(state);
    sessions()
        .lock()
        .map_err(|_| "HTML preview registry poisoned")?
        .insert(session_id.clone(), shutdown);
    tokio::spawn(async move {
        let mut closed = closed;
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                let _ = closed.wait_for(|closed| *closed).await;
            })
            .await;
    });
    Ok(HtmlPreviewCreateResponse {
        url: format!("http://127.0.0.1:{port}/__openbitfun_preview_bootstrap?previewToken={token}"),
        session_id,
    })
}

#[tauri::command]
pub async fn html_preview_release(request: HtmlPreviewReleaseRequest) -> Result<(), String> {
    if let Some(shutdown) = sessions()
        .lock()
        .map_err(|_| "HTML preview registry poisoned")?
        .remove(&request.session_id)
    {
        let _ = shutdown.send(true);
    }
    Ok(())
}

async fn preview_handler(
    State(state): State<PreviewState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    let query_token = uri.query().and_then(|query| {
        query.split('&').find_map(|pair| {
            let (key, value) = pair.split_once('=')?;
            (key == "previewToken").then_some(value)
        })
    });
    let cookie_authorized = headers
        .get(header::COOKIE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|cookies| {
            cookies
                .split(';')
                .filter_map(|cookie| cookie.trim().split_once('='))
                .any(|(key, value)| key == state.cookie_name && value == state.token)
        });
    if *state.closed.borrow()
        || !state.transfer.is_current()
        || (method != Method::GET && method != Method::HEAD)
    {
        return response(StatusCode::NOT_FOUND, "Not found");
    }
    if uri.path() == "/__openbitfun_preview_bootstrap" && query_token == Some(state.token.as_str())
    {
        return Response::builder()
            .status(StatusCode::FOUND)
            .header(
                header::LOCATION,
                if index_entry_filename(&state.entry_path).is_some() {
                    "/".to_string()
                } else {
                    format!("/{}", encode_url_path(&state.entry_path))
                },
            )
            .header(
                header::SET_COOKIE,
                format!(
                    "{}={}; HttpOnly; SameSite=Strict; Path=/",
                    state.cookie_name, state.token
                ),
            )
            .header(header::CACHE_CONTROL, "no-store")
            .header(header::REFERRER_POLICY, "no-referrer")
            .body(Body::empty())
            .unwrap_or_else(|_| {
                response(StatusCode::INTERNAL_SERVER_ERROR, "Invalid preview entry")
            });
    }
    if !cookie_authorized {
        return response(StatusCode::NOT_FOUND, "Not found");
    }
    let relative = match urlencoding::decode(uri.path().trim_start_matches('/')) {
        Ok(relative) => relative.into_owned(),
        Err(_) => return response(StatusCode::BAD_REQUEST, "Invalid preview path"),
    };
    let index_entry = index_entry_filename(&state.entry_path);
    if index_entry.is_some_and(|filename| relative == filename || relative == state.entry_path) {
        // The site router must see its public root, including when a link uses
        // the entry filename or an older workspace-prefixed preview URL.
        return Response::builder()
            .status(StatusCode::FOUND)
            .header(header::LOCATION, site_root_url(&uri))
            .header(header::CACHE_CONTROL, "no-store")
            .header(header::REFERRER_POLICY, "no-referrer")
            .body(Body::empty())
            .unwrap_or_else(|_| response(StatusCode::BAD_REQUEST, "Invalid preview path"));
    }
    let mut request = state.request.clone();
    request.resource_path = if index_entry.is_some() && relative.is_empty() {
        None
    } else {
        Some(relative.clone())
    };
    request.metadata_only = method == Method::HEAD;
    let bypass_cache = force_resource_reload(&headers);
    let resource = match state
        .transfer
        .open(
            request.clone(),
            bypass_cache,
            uri.path_and_query().map(|path| path.as_str().to_string()),
        )
        .await
    {
        Ok(resource) => resource,
        Err(error)
            if error.code == Code::NotFound
                && index_entry.is_some()
                && is_document_route(&relative, &headers) =>
        {
            // Existing files always win. Only document navigation can use the
            // selected index as a history-router fallback; assets, authorization
            // failures and offline owners retain their original error. None is
            // the existing v1 entry request, so older peer hosts work unchanged.
            request.resource_path = None;
            match state
                .transfer
                .open(request, bypass_cache, Some(site_root_url(&uri)))
                .await
            {
                Ok(resource) => resource,
                Err(error) => return preview_error_response(error),
            }
        }
        Err(error) => return preview_error_response(error),
    };
    let size = resource.metadata.size;
    let content_type = resource.metadata.mime_type;
    let body = Body::from_stream(
        resource
            .body
            .map_ok(|bytes| bytes.to_vec())
            .map_err(|error| std::io::Error::other(error.message)),
    );
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_LENGTH, size)
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::REFERRER_POLICY, "no-referrer")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .body(body)
        .unwrap_or_else(|_| {
            response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Invalid preview response",
            )
        })
}

fn index_entry_filename(entry_path: &str) -> Option<&str> {
    entry_path.rsplit('/').next().filter(|filename| {
        filename.eq_ignore_ascii_case("index.html") || filename.eq_ignore_ascii_case("index.htm")
    })
}

fn site_root_url(uri: &Uri) -> String {
    match uri.query() {
        Some(query) => format!("/?{query}"),
        None => "/".to_string(),
    }
}

fn is_document_route(path: &str, headers: &HeaderMap) -> bool {
    // Explicit filenames (including missing .html pages) remain ordinary file
    // requests. Browser fetches that accept */* are not page navigations.
    if path
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .is_some_and(|part| part.contains('.'))
    {
        return false;
    }
    if headers
        .get("sec-fetch-dest")
        .is_some_and(|value| value != "document" && value != "iframe" && value != "frame")
    {
        return false;
    }
    headers
        .get_all(header::ACCEPT)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .any(|value| {
            value.split(',').any(|range| {
                let mut parts = range.trim().split(';');
                parts
                    .next()
                    .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("text/html"))
                    && parts.all(|parameter| {
                        let Some((name, value)) = parameter.trim().split_once('=') else {
                            return true;
                        };
                        !name.trim().eq_ignore_ascii_case("q")
                            || value
                                .trim()
                                .parse::<f32>()
                                .is_ok_and(|quality| quality > 0.0 && quality <= 1.0)
                    })
            })
        })
}

fn force_resource_reload(headers: &HeaderMap) -> bool {
    [header::CACHE_CONTROL, header::PRAGMA].iter().any(|name| {
        headers
            .get_all(name)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .any(|value| {
                value.split(',').any(|directive| {
                    let (name, value) = directive
                        .trim()
                        .split_once('=')
                        .unwrap_or((directive.trim(), ""));
                    name.trim().eq_ignore_ascii_case("no-cache")
                        || name.trim().eq_ignore_ascii_case("no-store")
                        || (name.trim().eq_ignore_ascii_case("max-age")
                            && value.trim().trim_matches('"') == "0")
                })
            })
    })
}

fn preview_error_response(error: HtmlPreviewError) -> Response {
    let status = match error.code {
        Code::InvalidPath => StatusCode::BAD_REQUEST,
        Code::NotFound => StatusCode::NOT_FOUND,
        Code::Forbidden => StatusCode::FORBIDDEN,
        Code::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
        Code::Changed => StatusCode::CONFLICT,
        Code::Unavailable => StatusCode::BAD_GATEWAY,
    };
    response(status, &error.message)
}
fn encode_url_path(path: &str) -> String {
    path.split('/')
        .map(|component| urlencoding::encode(component).into_owned())
        .collect::<Vec<_>>()
        .join("/")
}
fn response(status: StatusCode, body: &str) -> Response {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::REFERRER_POLICY, "no-referrer")
        .body(Body::from(body.to_string()))
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

#[cfg(test)]
pub(super) mod tests;
