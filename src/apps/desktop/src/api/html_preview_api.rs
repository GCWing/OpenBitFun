//! Read-only HTTP gateway used to preview workspace HTML files in the embedded browser.

use crate::api::app_state::AppState;
use crate::api::path_target::{resolve_desktop_path_target, DesktopPathTarget};
use axum::body::Body;
use axum::extract::State;
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode, Uri};
use axum::response::Response;
use axum::routing::any;
use axum::Router;
use openbitfun_core::service::remote_ssh::RemoteFileService;
use serde::{Deserialize, Serialize};
use std::path::{Path as FsPath, PathBuf};
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::{oneshot, RwLock};
use uuid::Uuid;

const MAX_PREVIEW_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HtmlPreviewCreateRequest {
    pub file_path: String,
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// Temporary pre-ID wire field; normal clients send workspaceId.
    #[serde(default)]
    pub workspace_path: String,
    #[serde(default)]
    pub remote_connection_id: Option<String>,
    #[serde(default)]
    pub peer_device_mode: bool,
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

#[derive(Clone)]
enum PreviewRoot {
    Local { root: PathBuf },
    Remote { root: String, connection_id: String },
}

#[derive(Clone)]
struct PreviewState {
    token: String,
    root: PreviewRoot,
    entry_path: String,
    remote_file_service: Arc<RwLock<Option<RemoteFileService>>>,
}

struct PreviewSession {
    shutdown: Option<oneshot::Sender<()>>,
}

static SESSIONS: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<String, PreviewSession>>,
> = std::sync::OnceLock::new();

fn sessions() -> &'static std::sync::Mutex<std::collections::HashMap<String, PreviewSession>> {
    SESSIONS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

#[tauri::command]
pub async fn html_preview_create(
    app_state: tauri::State<'_, AppState>,
    request: HtmlPreviewCreateRequest,
) -> Result<HtmlPreviewCreateResponse, String> {
    if request.peer_device_mode {
        return Err("HTML preview is not supported while controlling a peer device".to_string());
    }
    let record = match request.workspace_id.as_deref() {
        Some(id) => app_state
            .workspace_service
            .require_workspace(id)
            .await
            .map_err(|e| e.to_string())?,
        None => app_state
            .workspace_service
            .resolve_legacy_workspace_reference(
                None,
                &request.workspace_path,
                request.remote_connection_id.as_deref(),
                None,
            )
            .await
            .map_err(|e| e.to_string())?
            .ok_or("HTML preview workspace is unavailable")?,
    };
    let workspace = record.root_path.to_string_lossy();
    let connection = record.filesystem_connection_id()?;
    let target = resolve_desktop_path_target(
        &app_state,
        &request.file_path,
        Some(connection.unwrap_or("")),
        Some(&record.id),
    )
    .await?;
    let (root, entry_relative_path) = match target {
        DesktopPathTarget::Local { resolved_path, .. } => {
            let workspace_root = std::fs::canonicalize(workspace.as_ref())
                .map_err(|e| format!("Failed to resolve workspace root: {e}"))?;
            let entry = std::fs::canonicalize(&resolved_path)
                .map_err(|e| format!("Failed to resolve HTML file: {e}"))?;
            if !entry.starts_with(&workspace_root) || !entry.is_file() {
                return Err("HTML file is outside the workspace or is not a file".to_string());
            }
            let relative = entry
                .strip_prefix(&workspace_root)
                .map_err(|_| "HTML file is outside the workspace".to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            (
                PreviewRoot::Local {
                    root: workspace_root,
                },
                relative,
            )
        }
        DesktopPathTarget::Remote { entry, .. } => {
            let remote_root = normalize_remote_path(&workspace);
            let file_path = normalize_remote_path(&request.file_path);
            if !is_under_remote_root(&file_path, &remote_root) {
                return Err("HTML file is outside the remote workspace".to_string());
            }
            let remote_fs = app_state
                .get_remote_file_service_async()
                .await
                .map_err(|e| format!("Remote file service not available: {e}"))?;
            ensure_remote_file(&remote_fs, &entry.connection_id, &file_path).await?;
            let relative = file_path
                .strip_prefix(remote_root.trim_end_matches('/'))
                .unwrap_or(&file_path)
                .trim_start_matches('/')
                .to_string();
            (
                PreviewRoot::Remote {
                    root: remote_root,
                    connection_id: entry.connection_id,
                },
                relative,
            )
        }
    };

    let token = Uuid::new_v4().simple().to_string();
    let session_id = Uuid::new_v4().simple().to_string();
    let state = PreviewState {
        token: token.clone(),
        root,
        entry_path: entry_relative_path.clone(),
        remote_file_service: Arc::clone(&app_state.remote_file_service),
    };
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| format!("Failed to bind HTML preview server: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let router = Router::new()
        .fallback(any(preview_handler))
        .with_state(state);
    tokio::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            })
            .await;
    });
    sessions()
        .lock()
        .map_err(|_| "HTML preview registry poisoned".to_string())?
        .insert(
            session_id.clone(),
            PreviewSession {
                shutdown: Some(shutdown_tx),
            },
        );

    Ok(HtmlPreviewCreateResponse {
        url: format!("http://127.0.0.1:{port}/__openbitfun_preview_bootstrap?previewToken={token}"),
        session_id,
    })
}

#[tauri::command]
pub async fn html_preview_release(request: HtmlPreviewReleaseRequest) -> Result<(), String> {
    if let Some(mut session) = sessions()
        .lock()
        .map_err(|_| "HTML preview registry poisoned".to_string())?
        .remove(&request.session_id)
    {
        if let Some(shutdown) = session.shutdown.take() {
            let _ = shutdown.send(());
        }
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
            cookies.split(';').any(|cookie| {
                cookie.trim().strip_prefix("openbitfun_html_preview=") == Some(state.token.as_str())
            })
        });
    let bootstrap_authorized = query_token == Some(state.token.as_str());
    if (!bootstrap_authorized && !cookie_authorized)
        || (method != Method::GET && method != Method::HEAD)
    {
        return response(
            StatusCode::NOT_FOUND,
            "Not found",
            "text/plain; charset=utf-8",
        );
    }
    if uri.path() == "/__openbitfun_preview_bootstrap" {
        let location = format!("/{}", encode_url_path(&state.entry_path));
        let cookie = format!(
            "openbitfun_html_preview={}; HttpOnly; SameSite=Strict; Path=/",
            state.token
        );
        return Response::builder()
            .status(StatusCode::FOUND)
            .header(header::LOCATION, location)
            .header(header::SET_COOKIE, cookie)
            .header(header::CACHE_CONTROL, "no-store")
            .header(header::REFERRER_POLICY, "no-referrer")
            .body(Body::empty())
            .unwrap_or_else(|_| Response::new(Body::empty()));
    }
    let relative = match urlencoding::decode(uri.path().trim_start_matches('/')) {
        Ok(relative) => relative,
        Err(_) => {
            return response(
                StatusCode::BAD_REQUEST,
                "Invalid preview path",
                "text/plain; charset=utf-8",
            )
        }
    };
    let result = match &state.root {
        PreviewRoot::Local { root } => read_local(root, &relative).await,
        PreviewRoot::Remote {
            root,
            connection_id,
        } => read_remote(&state, root, connection_id, &relative).await,
    };
    match result {
        Ok((bytes, content_type)) => {
            let mut builder = Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, content_type)
                .header(header::CACHE_CONTROL, "no-store")
                .header(header::REFERRER_POLICY, "no-referrer")
                .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff");
            if bootstrap_authorized {
                let cookie = format!(
                    "openbitfun_html_preview={}; HttpOnly; SameSite=Strict; Path=/",
                    state.token
                );
                if let Ok(value) = HeaderValue::from_str(&cookie) {
                    builder = builder.header(header::SET_COOKIE, value);
                }
            }
            if method == Method::HEAD {
                builder = builder.header(header::CONTENT_LENGTH, bytes.len().to_string());
                builder.body(Body::empty()).unwrap_or_else(|_| {
                    response(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "Internal error",
                        "text/plain",
                    )
                })
            } else {
                builder.body(Body::from(bytes)).unwrap_or_else(|_| {
                    response(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "Internal error",
                        "text/plain",
                    )
                })
            }
        }
        Err((status, message)) => response(status, &message, "text/plain; charset=utf-8"),
    }
}

async fn read_local(
    root: &FsPath,
    relative: &str,
) -> Result<(Vec<u8>, String), (StatusCode, String)> {
    let requested = confined_local_path(root, relative)?;
    let path = tokio::fs::canonicalize(&requested)
        .await
        .map_err(|_| (StatusCode::NOT_FOUND, "Not found".to_string()))?;
    if !path.starts_with(root) {
        return Err((StatusCode::NOT_FOUND, "Not found".to_string()));
    }
    let metadata = tokio::fs::symlink_metadata(&path)
        .await
        .map_err(|_| (StatusCode::NOT_FOUND, "Not found".to_string()))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err((StatusCode::NOT_FOUND, "Not found".to_string()));
    }
    if metadata.len() > MAX_PREVIEW_BYTES {
        return Err((
            StatusCode::PAYLOAD_TOO_LARGE,
            "Preview file is too large".to_string(),
        ));
    }
    let bytes = tokio::fs::read(&path).await.map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to read preview file".to_string(),
        )
    })?;
    Ok((bytes, mime_for_path(relative)))
}

async fn read_remote(
    state: &PreviewState,
    root: &str,
    connection_id: &str,
    relative: &str,
) -> Result<(Vec<u8>, String), (StatusCode, String)> {
    let path = confined_remote_path(root, relative)?;
    let service = state.remote_file_service.read().await.clone().ok_or((
        StatusCode::SERVICE_UNAVAILABLE,
        "Remote file service unavailable".to_string(),
    ))?;
    let metadata = ensure_confined_remote_file(&service, connection_id, root, relative)
        .await
        .map_err(|e| (StatusCode::NOT_FOUND, e))?;
    if metadata > MAX_PREVIEW_BYTES {
        return Err((
            StatusCode::PAYLOAD_TOO_LARGE,
            "Preview file is too large".to_string(),
        ));
    }
    let bytes = service.read_file(connection_id, &path).await.map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Failed to read remote preview file: {e}"),
        )
    })?;
    Ok((bytes, mime_for_path(relative)))
}

async fn ensure_remote_file(
    service: &RemoteFileService,
    connection_id: &str,
    path: &str,
) -> Result<u64, String> {
    let metadata = service
        .workspace_metadata(connection_id, path, false)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Not found".to_string())?;
    if metadata.kind != openbitfun_runtime_ports::WorkspacePathKind::File {
        return Err("Not found".to_string());
    }
    Ok(metadata.size.unwrap_or(0))
}

async fn ensure_confined_remote_file(
    service: &RemoteFileService,
    connection_id: &str,
    root: &str,
    relative: &str,
) -> Result<u64, String> {
    let mut current = root.trim_end_matches('/').to_string();
    let components: Vec<&str> = relative
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();
    for (index, component) in components.iter().enumerate() {
        current = if current.is_empty() || current == "/" {
            format!("/{component}")
        } else {
            format!("{current}/{component}")
        };
        let metadata = service
            .workspace_metadata(connection_id, &current, false)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Not found".to_string())?;
        if metadata.kind == openbitfun_runtime_ports::WorkspacePathKind::Symlink {
            return Err("Symbolic links are not available in HTML preview".to_string());
        }
        let is_last = index + 1 == components.len();
        if is_last {
            if metadata.kind != openbitfun_runtime_ports::WorkspacePathKind::File {
                return Err("Not found".to_string());
            }
            return Ok(metadata.size.unwrap_or(0));
        }
        if metadata.kind != openbitfun_runtime_ports::WorkspacePathKind::Directory {
            return Err("Not found".to_string());
        }
    }
    Err("Not found".to_string())
}

fn confined_local_path(root: &FsPath, relative: &str) -> Result<PathBuf, (StatusCode, String)> {
    let mut path = root.to_path_buf();
    for component in relative.split('/') {
        if component.is_empty() || component == "." {
            continue;
        }
        if component == ".." || component.contains('\\') {
            return Err((StatusCode::BAD_REQUEST, "Invalid preview path".to_string()));
        }
        path.push(component);
    }
    Ok(path)
}

fn normalize_remote_path(path: &str) -> String {
    let mut result = String::from("/");
    for component in path.split('/') {
        if component.is_empty() || component == "." {
            continue;
        }
        if component == ".." {
            let parent = result
                .rsplit_once('/')
                .map(|(prefix, _)| prefix.to_string());
            result = parent
                .filter(|prefix| !prefix.is_empty())
                .unwrap_or_else(|| "/".to_string());
        } else {
            if !result.ends_with('/') {
                result.push('/');
            }
            result.push_str(component);
        }
    }
    if result.len() > 1 {
        result.trim_end_matches('/').to_string()
    } else {
        result
    }
}

fn is_under_remote_root(path: &str, root: &str) -> bool {
    path == root || (root == "/" && path.starts_with('/')) || path.starts_with(&format!("{root}/"))
}

fn confined_remote_path(root: &str, relative: &str) -> Result<String, (StatusCode, String)> {
    if relative
        .split('/')
        .any(|part| part == ".." || part.contains('\\'))
    {
        return Err((StatusCode::BAD_REQUEST, "Invalid preview path".to_string()));
    }
    let path = normalize_remote_path(&format!("{root}/{relative}"));
    if !is_under_remote_root(&path, root) {
        return Err((StatusCode::NOT_FOUND, "Not found".to_string()));
    }
    Ok(path)
}

fn mime_for_path(path: &str) -> String {
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    if mime.type_() == mime_guess::mime::TEXT {
        format!("{}; charset=utf-8", mime.essence_str())
    } else {
        mime.to_string()
    }
}

fn encode_url_path(path: &str) -> String {
    path.split('/')
        .map(|component| urlencoding::encode(component).into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

fn response(status: StatusCode, body: &str, content_type: &'static str) -> Response {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .body(Body::from(body.to_string()))
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn current_and_100_preview_requests_have_distinct_identity_inputs() {
        let current: HtmlPreviewCreateRequest = serde_json::from_value(serde_json::json!({
            "workspaceId": "remote-id", "filePath": "/repo/index.html"
        }))
        .unwrap();
        assert_eq!(current.workspace_id.as_deref(), Some("remote-id"));
        assert!(current.workspace_path.is_empty());
        assert!(current.remote_connection_id.is_none());
        let legacy: HtmlPreviewCreateRequest = serde_json::from_value(serde_json::json!({
            "workspacePath": "/repo", "filePath": "/repo/index.html", "remoteConnectionId": "ssh-1"
        }))
        .unwrap();
        assert!(legacy.workspace_id.is_none());
        assert_eq!(legacy.workspace_path, "/repo");
        assert_eq!(legacy.remote_connection_id.as_deref(), Some("ssh-1"));
    }
    #[test]
    fn rejects_traversal() {
        assert!(confined_remote_path("/workspace", "../secret").is_err());
        assert!(confined_local_path(FsPath::new("/workspace"), "../secret").is_err());
    }
    #[test]
    fn preserves_relative_resources() {
        assert_eq!(
            confined_remote_path("/workspace", "assets/app.css").unwrap(),
            "/workspace/assets/app.css"
        );
    }
}
