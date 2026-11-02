//! OpenBitFun Page: versioned publish + Page Functions serve.
//!
//! Flow: upload draft → freeze version → deploy production pointer.
//! Preview: `/p/{user}/{slug}/@v/{version}/...`
//! Production: `/p/{user}/{slug}/...` (deployed version only).

use axum::extract::{ConnectInfo, DefaultBodyLimit, Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use dashmap::DashMap;
use openbitfun_page_function_runtime::{
    run_fetch, FetchRequest, PageFunctionError, PageMeta, DEFAULT_TIMEOUT, WORKER_ENTRY_PATH,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use crate::db::{
    new_page_version_id, page_draft_asset_key, page_legacy_asset_key, page_version_asset_key,
    DeletePageVersionOutcome, PageMutationOutcome, PageRow, PageVersionRow, PageVisibility,
    PageWithUsername, SavePageVersionOutcome, UserRow,
};
use crate::page_data::RelayPageHost;
use crate::routes::api::AppState;
use crate::routes::auth::{extract_bearer_token, validate_auth, validate_token, AuthUser};
use crate::WebAssetStore;

pub const MAX_PAGES_PER_USER: i64 = 50;
pub const MAX_VERSIONS_PER_PAGE: i64 = 30;
pub const MAX_PAGE_BYTES: u64 = 100 * 1024 * 1024;
pub const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;
pub const MAX_PAGE_FILES: usize = 4096;
const MAX_PAGE_TITLE_CHARS: usize = 120;
const MAX_PAGE_TITLE_BYTES: usize = 512;
const MAX_PAGE_NOTE_CHARS: usize = 1000;
const MAX_PAGE_NOTE_BYTES: usize = 4096;
// A 10 MiB file expands to roughly 13.34 MiB in base64 before JSON framing.
pub const PAGE_UPLOAD_BODY_LIMIT: usize = 15 * 1024 * 1024;
const PAGE_BROWSER_GRANT_TTL: Duration = Duration::from_secs(8 * 60 * 60);
const PAGE_LOGIN_REQUEST_TTL: Duration = Duration::from_secs(5 * 60);
const PAGE_LOGIN_EXCHANGE_TTL: Duration = Duration::from_secs(60);
const MAX_PAGE_BROWSER_GRANTS: usize = 8192;
const MAX_PAGE_BROWSER_GRANTS_PER_USER: usize = 512;
const MAX_PAGE_LOGIN_REQUESTS: usize = 4096;
const MAX_PAGE_LOGIN_EXCHANGES: usize = 4096;
const PAGE_ACCESS_COOKIE: &str = "openbitfun_page_access";
const PAGE_UPLOAD_SESSION_TTL: Duration = Duration::from_secs(15 * 60);
const MAX_PAGE_UPLOAD_SESSIONS: usize = 4096;
const MAX_PAGE_UPLOAD_SESSIONS_PER_USER: usize = 64;
const PAGE_UPLOAD_LOCK_SHARDS: usize = 64;

#[derive(Clone)]
struct PageAccessScope {
    user_id: String,
    viewer_user_id: String,
    slug: String,
    generation: String,
    version_id: Option<String>,
    expires_at: Instant,
}

#[derive(Clone)]
struct PageLoginRequest {
    user_id: String,
    slug: String,
    generation: String,
    version_id: Option<String>,
    page_path: String,
    cookie_path: String,
    expires_at: Instant,
}

#[derive(Clone)]
struct PageLoginExchange {
    request: PageLoginRequest,
    viewer_user_id: String,
    expires_at: Instant,
}

/// Process-local, time-bounded browser sessions for authenticated Pages.
pub struct PageAccessManager {
    browser_grants: DashMap<String, PageAccessScope>,
    login_requests: DashMap<String, PageLoginRequest>,
    login_exchanges: DashMap<String, PageLoginExchange>,
    capacity_lock: StdMutex<()>,
}

#[derive(Clone)]
struct PageUploadSession {
    user_id: String,
    upload_id: Option<String>,
    draft_key: String,
    manifest: HashMap<String, String>,
    finalized: bool,
    title: Option<String>,
    visibility: Option<PageVisibility>,
    expected_generation: Option<String>,
    create: bool,
    expires_at: Instant,
}

/// Tracks the one active, manifest-bound upload session for each Page. Drafts
/// use upload-specific asset namespaces, so superseded/concurrent uploads can
/// never mix files before an immutable version is frozen.
pub struct PageUploadManager {
    sessions: DashMap<String, PageUploadSession>,
    locks: Vec<tokio::sync::Mutex<()>>,
    capacity_lock: StdMutex<()>,
}

impl Default for PageUploadManager {
    fn default() -> Self {
        Self::new()
    }
}

impl PageUploadManager {
    pub fn new() -> Self {
        Self {
            sessions: DashMap::new(),
            locks: (0..PAGE_UPLOAD_LOCK_SHARDS)
                .map(|_| tokio::sync::Mutex::new(()))
                .collect(),
            capacity_lock: StdMutex::new(()),
        }
    }

    fn lock_index(&self, page_key: &str) -> usize {
        let mut hasher = DefaultHasher::new();
        page_key.hash(&mut hasher);
        hasher.finish() as usize % self.locks.len()
    }

    fn lock_for(&self, page_key: &str) -> &tokio::sync::Mutex<()> {
        &self.locks[self.lock_index(page_key)]
    }

    async fn prune_expired(&self, now: Instant) -> Vec<String> {
        let mut expired_drafts = Vec::new();
        // Acquire the exact shard used by every handler before removing its
        // sessions. An upload that passed its lease check and is still doing
        // storage/DB work therefore cannot be pruned from another Page.
        for shard_index in 0..self.locks.len() {
            let _guard = self.locks[shard_index].lock().await;
            let expired_keys = self
                .sessions
                .iter()
                .filter(|entry| {
                    self.lock_index(entry.key()) == shard_index && entry.expires_at <= now
                })
                .map(|entry| entry.key().clone())
                .collect::<Vec<_>>();
            for key in expired_keys {
                if let Some((_, session)) = self.sessions.remove(&key) {
                    expired_drafts.push(session.draft_key);
                }
            }
        }
        expired_drafts
    }
}

impl Default for PageAccessManager {
    fn default() -> Self {
        Self {
            browser_grants: DashMap::new(),
            login_requests: DashMap::new(),
            login_exchanges: DashMap::new(),
            capacity_lock: StdMutex::new(()),
        }
    }
}

impl PageAccessManager {
    pub fn new() -> Self {
        Self::default()
    }

    fn prune_expired(&self, now: Instant) {
        self.browser_grants
            .retain(|_, scope| scope.expires_at > now);
        self.login_requests
            .retain(|_, request| request.expires_at > now);
        self.login_exchanges
            .retain(|_, exchange| exchange.expires_at > now);
    }

    fn issue_browser_grant(
        &self,
        user_id: String,
        viewer_user_id: String,
        slug: String,
        generation: String,
        version_id: Option<String>,
    ) -> Result<String, StatusCode> {
        let _capacity_guard = self
            .capacity_lock
            .lock()
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let now = Instant::now();
        self.prune_expired(now);
        let viewer_grants = self
            .browser_grants
            .iter()
            .filter(|entry| entry.viewer_user_id == viewer_user_id)
            .count();
        if self.browser_grants.len() >= MAX_PAGE_BROWSER_GRANTS
            || viewer_grants >= MAX_PAGE_BROWSER_GRANTS_PER_USER
        {
            return Err(StatusCode::TOO_MANY_REQUESTS);
        }
        let grant = random_page_access_token();
        self.browser_grants.insert(
            grant.clone(),
            PageAccessScope {
                user_id,
                viewer_user_id,
                slug,
                generation,
                version_id,
                expires_at: now + PAGE_BROWSER_GRANT_TTL,
            },
        );
        Ok(grant)
    }

    fn issue_login_request(
        &self,
        user_id: String,
        slug: String,
        generation: String,
        version_id: Option<String>,
        page_path: String,
        cookie_path: String,
    ) -> Result<String, StatusCode> {
        let _capacity_guard = self
            .capacity_lock
            .lock()
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let now = Instant::now();
        self.prune_expired(now);
        if self.login_requests.len() >= MAX_PAGE_LOGIN_REQUESTS {
            return Err(StatusCode::TOO_MANY_REQUESTS);
        }
        let token = random_page_access_token();
        self.login_requests.insert(
            token.clone(),
            PageLoginRequest {
                user_id,
                slug,
                generation,
                version_id,
                page_path,
                cookie_path,
                expires_at: now + PAGE_LOGIN_REQUEST_TTL,
            },
        );
        Ok(token)
    }

    fn login_request(&self, token: &str) -> Option<PageLoginRequest> {
        let now = Instant::now();
        let request = self
            .login_requests
            .get(token)
            .filter(|request| request.expires_at > now)
            .map(|request| request.value().clone());
        if request.is_none() {
            self.login_requests.remove(token);
            self.prune_expired(now);
        }
        request
    }

    fn issue_login_exchange(
        &self,
        request_token: &str,
        viewer_user_id: String,
    ) -> Result<Option<String>, StatusCode> {
        let _capacity_guard = self
            .capacity_lock
            .lock()
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let now = Instant::now();
        self.prune_expired(now);
        if self.login_exchanges.len() >= MAX_PAGE_LOGIN_EXCHANGES {
            return Err(StatusCode::TOO_MANY_REQUESTS);
        }
        let Some((_, request)) = self.login_requests.remove(request_token) else {
            return Ok(None);
        };
        if request.expires_at <= now {
            return Ok(None);
        }
        let code = random_page_access_token();
        self.login_exchanges.insert(
            code.clone(),
            PageLoginExchange {
                request,
                viewer_user_id,
                expires_at: now + PAGE_LOGIN_EXCHANGE_TTL,
            },
        );
        Ok(Some(code))
    }

    fn consume_login_exchange(&self, code: &str) -> Result<Option<PageLoginExchange>, StatusCode> {
        let _capacity_guard = self
            .capacity_lock
            .lock()
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let now = Instant::now();
        self.prune_expired(now);
        let Some((_, exchange)) = self.login_exchanges.remove(code) else {
            return Ok(None);
        };
        Ok((exchange.expires_at > now).then_some(exchange))
    }

    fn authorizes_page(
        &self,
        headers: &HeaderMap,
        user_id: &str,
        slug: &str,
        generation: &str,
        version_id: Option<&str>,
    ) -> bool {
        let now = Instant::now();
        let mut authorized = false;
        for cookie_header in headers.get_all(header::COOKIE) {
            let Ok(value) = cookie_header.to_str() else {
                continue;
            };
            for cookie in value.split(';') {
                let Some((name, token)) = cookie.trim().split_once('=') else {
                    continue;
                };
                if name != PAGE_ACCESS_COOKIE {
                    continue;
                }
                let Some(scope) = self.browser_grants.get(token) else {
                    continue;
                };
                if scope.expires_at > now
                    && scope.user_id == user_id
                    && scope.slug == slug
                    && scope.generation == generation
                    && scope.version_id.as_deref() == version_id
                {
                    authorized = true;
                    break;
                }
            }
            if authorized {
                break;
            }
        }
        if !authorized {
            self.prune_expired(now);
        }
        authorized
    }

    fn revoke_page(&self, user_id: &str, slug: &str) {
        self.browser_grants
            .retain(|_, scope| scope.user_id != user_id || scope.slug != slug);
        self.login_requests
            .retain(|_, request| request.user_id != user_id || request.slug != slug);
        self.login_exchanges.retain(|_, exchange| {
            exchange.request.user_id != user_id || exchange.request.slug != slug
        });
    }
}

fn random_page_access_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

fn is_valid_page_upload_id(upload_id: &str) -> bool {
    upload_id.len() == 32 && upload_id.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn is_valid_page_title(title: &str) -> bool {
    !title.trim().is_empty()
        && title.len() <= MAX_PAGE_TITLE_BYTES
        && title.chars().count() <= MAX_PAGE_TITLE_CHARS
        && !title.chars().any(char::is_control)
}

fn is_valid_page_note(note: &str) -> bool {
    note.len() <= MAX_PAGE_NOTE_BYTES
        && note.chars().count() <= MAX_PAGE_NOTE_CHARS
        && !note.chars().any(char::is_control)
}

fn page_upload_session_key(user_id: &str, slug: &str) -> String {
    format!("{user_id}\0{slug}")
}

fn page_upload_draft_key(user_id: &str, slug: &str, upload_id: &str) -> String {
    format!("pages/{user_id}/{slug}/draft/{upload_id}")
}

fn is_valid_slug(slug: &str) -> bool {
    let bytes = slug.as_bytes();
    if bytes.is_empty() || bytes.len() > 64 {
        return false;
    }
    let Some(first) = bytes.first() else {
        return false;
    };
    if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
        return false;
    }
    bytes
        .iter()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

fn is_valid_page_generation(generation: &str) -> bool {
    generation.len() == 32 && generation.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn validate_optional_expected_generation(value: Option<&str>) -> Result<Option<&str>, StatusCode> {
    match value {
        None | Some("") => Ok(None),
        Some(generation) if is_valid_page_generation(generation) => Ok(value),
        Some(_) => Err(StatusCode::BAD_REQUEST),
    }
}

/// Bind a management request to the Page generation visible while the caller
/// holds the Page lifecycle lock. Pre-generation clients omit the fence and
/// intentionally operate on that current generation; generation-aware clients
/// retain the explicit mismatch fence across delete/recreate ABA transitions.
async fn bind_page_generation_locked(
    db: &crate::db::DbPool,
    user_id: &str,
    slug: &str,
    expected_generation: Option<&str>,
) -> Result<PageRow, StatusCode> {
    let page = PageRow::get(db, user_id, slug)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;
    if expected_generation.is_some_and(|expected| expected != page.generation) {
        return Err(StatusCode::CONFLICT);
    }
    Ok(page)
}

fn generation_intent_matches(
    page: Option<&PageRow>,
    expected_generation: Option<&str>,
    create: bool,
) -> bool {
    match page {
        Some(page) => {
            !create
                && expected_generation.is_some_and(|expected| {
                    is_valid_page_generation(expected) && expected == page.generation
                })
        }
        None => create && expected_generation.is_none(),
    }
}

fn is_legacy_upload_generation_intent(expected_generation: Option<&str>, create: bool) -> bool {
    expected_generation.is_none() && !create
}

/// Resolve the upload intent at the manifest-check boundary. Clients from
/// before the generation protocol omit both fields; bind those requests to
/// the exact Page generation observed by the relay (or to an explicit create
/// intent when the slug is absent). The server-owned session carries that
/// binding through upload and freeze, so this compatibility path cannot turn
/// into an unfenced mutation after a delete/recreate ABA transition.
fn resolve_upload_generation_intent(
    page: Option<&PageRow>,
    expected_generation: Option<&str>,
    create: bool,
) -> Option<(Option<String>, bool)> {
    if is_legacy_upload_generation_intent(expected_generation, create) {
        let resolved_generation = page.map(|page| page.generation.clone());
        let resolved_create = page.is_none();
        return generation_intent_matches(page, resolved_generation.as_deref(), resolved_create)
            .then_some((resolved_generation, resolved_create));
    }
    generation_intent_matches(page, expected_generation, create)
        .then(|| (expected_generation.map(str::to_string), create))
}

fn upload_request_matches_session_intent(
    expected_generation: Option<&str>,
    create: bool,
    session: &PageUploadSession,
) -> bool {
    is_legacy_upload_generation_intent(expected_generation, create)
        || (session.expected_generation.as_deref() == expected_generation
            && session.create == create)
}

fn require_db(state: &AppState) -> Result<&crate::db::DbPool, StatusCode> {
    Ok(state.db.as_ref())
}

pub fn pages_router() -> Router<AppState> {
    Router::new()
        .route("/api/pages", get(list_pages))
        .route(
            "/api/pages/check-files",
            post(check_page_files).layer(DefaultBodyLimit::max(PAGE_UPLOAD_BODY_LIMIT)),
        )
        .route(
            "/api/pages/upload-files",
            post(upload_page_files).layer(DefaultBodyLimit::max(PAGE_UPLOAD_BODY_LIMIT)),
        )
        .route(
            "/api/pages/{slug}/versions",
            get(list_versions).post(freeze_version),
        )
        .route("/api/pages/{slug}/deploy", post(deploy_version))
        .route("/api/pages/{slug}/unpublish", post(unpublish_page))
        .route(
            "/api/pages/{slug}/versions/{version_id}",
            axum::routing::delete(delete_version),
        )
        .route(
            "/api/pages/{slug}",
            post(create_open_ticket)
                .patch(update_page)
                .delete(delete_page),
        )
        .route("/api/page-auth/login", post(page_browser_login))
        .route("/api/page-auth/sign-in", get(page_browser_sign_in))
        .route("/api/page-auth/callback", get(page_browser_callback))
        .route("/api/page-auth/client.js", get(page_auth_client_script))
        // Preview routes (more specific first).
        .route(
            "/p/{username}/{slug}/@v/{version_id}",
            get(serve_preview_root)
                .post(serve_preview_root)
                .layer(DefaultBodyLimit::max(
                    crate::page_execution::MAX_PAGE_FUNCTION_REQUEST_BODY_BYTES,
                )),
        )
        .route(
            "/p/{username}/{slug}/@v/{version_id}/{*path}",
            get(serve_preview_path)
                .post(serve_preview_path)
                .put(serve_preview_path)
                .delete(serve_preview_path)
                .patch(serve_preview_path)
                .layer(DefaultBodyLimit::max(
                    crate::page_execution::MAX_PAGE_FUNCTION_REQUEST_BODY_BYTES,
                )),
        )
        .route(
            "/p/{username}/{slug}",
            get(serve_prod_root)
                .post(serve_prod_root)
                .layer(DefaultBodyLimit::max(
                    crate::page_execution::MAX_PAGE_FUNCTION_REQUEST_BODY_BYTES,
                )),
        )
        .route(
            "/p/{username}/{slug}/{*path}",
            get(serve_prod_path)
                .post(serve_prod_path)
                .put(serve_prod_path)
                .delete(serve_prod_path)
                .patch(serve_prod_path)
                .layer(DefaultBodyLimit::max(
                    crate::page_execution::MAX_PAGE_FUNCTION_REQUEST_BODY_BYTES,
                )),
        )
}

// ── Types ───────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct FileManifestEntry {
    pub path: String,
    pub hash: String,
    pub size: u64,
}

#[derive(Deserialize)]
pub struct CheckPageFilesRequest {
    pub slug: String,
    #[serde(default)]
    pub upload_id: Option<String>,
    #[serde(default)]
    pub expected_generation: Option<String>,
    #[serde(default)]
    pub create: bool,
    pub files: Vec<FileManifestEntry>,
}

#[derive(Serialize)]
pub struct CheckPageFilesResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upload_id: Option<String>,
    pub expected_generation: Option<String>,
    pub create: bool,
    pub needed: Vec<String>,
    pub existing_count: usize,
    pub total_count: usize,
    pub freeze_idempotency_supported: bool,
    pub metadata_preconditions_supported: bool,
}

#[derive(Deserialize)]
pub struct UploadFileEntry {
    pub content: String,
    pub hash: String,
}

#[derive(Deserialize)]
pub struct UploadPageFilesRequest {
    pub slug: String,
    #[serde(default)]
    pub upload_id: Option<String>,
    #[serde(default)]
    pub expected_generation: Option<String>,
    #[serde(default)]
    pub create: bool,
    #[serde(default)]
    pub title: String,
    pub visibility: String,
    pub files: HashMap<String, UploadFileEntry>,
    #[serde(default)]
    pub finalize: bool,
}

#[derive(Deserialize)]
pub struct FreezeVersionRequest {
    #[serde(default)]
    pub upload_id: Option<String>,
    #[serde(default)]
    pub expected_generation: Option<String>,
    #[serde(default)]
    pub expected_visibility: Option<String>,
    #[serde(default)]
    pub expected_title: Option<String>,
    #[serde(default)]
    pub create: bool,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub note: String,
}

#[derive(Deserialize)]
pub struct DeployRequest {
    pub version_id: String,
    #[serde(default)]
    pub expected_generation: Option<String>,
}

#[derive(Serialize)]
pub struct PageInfo {
    pub slug: String,
    pub generation: String,
    pub visibility: String,
    pub title: String,
    pub file_count: i64,
    pub total_bytes: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub url_path: String,
    pub preview_url_path: Option<String>,
    pub deployed_version_id: Option<String>,
}

#[derive(Serialize)]
pub struct VersionInfo {
    pub generation: String,
    pub version_id: String,
    pub title: String,
    pub file_count: i64,
    pub total_bytes: i64,
    pub has_worker: bool,
    pub note: String,
    pub created_at: i64,
    pub deployed: bool,
    pub preview_url_path: String,
}

#[derive(Deserialize)]
pub struct UpdatePageRequest {
    #[serde(default)]
    pub expected_generation: Option<String>,
    pub visibility: Option<String>,
    pub title: Option<String>,
}

#[derive(Deserialize)]
pub struct PageOpenRequest {
    #[serde(default)]
    pub expected_generation: Option<String>,
    #[serde(default)]
    pub version_id: Option<String>,
}

#[derive(Deserialize)]
pub struct ExpectedGenerationQuery {
    #[serde(default)]
    pub expected_generation: Option<String>,
}

#[derive(Serialize)]
pub struct PageOpenResponse {
    pub open_url_path: String,
    pub page_url_path: String,
    pub expires_in_seconds: u64,
}

// ── Management ──────────────────────────────────────────────────────────

async fn create_open_ticket(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(slug): Path<String>,
    Json(body): Json<PageOpenRequest>,
) -> Result<Json<PageOpenResponse>, StatusCode> {
    let auth = validate_auth(&state, &headers).await?;
    let db = require_db(&state)?;
    if !is_valid_slug(&slug) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let expected_generation =
        validate_optional_expected_generation(body.expected_generation.as_deref())?;
    let _lifecycle_guard = state
        .page_execution_guard
        .acquire_page_read(&auth.user_id, &slug)
        .await;
    let page = bind_page_generation_locked(db, &auth.user_id, &slug, expected_generation).await?;
    let username = UserRow::find_by_username_for_user_id(db, &auth.user_id)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;
    if !is_safe_page_username(&username) {
        return Err(StatusCode::BAD_REQUEST);
    }

    let version_id = body
        .version_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if let Some(version_id) = version_id.as_deref() {
        PageVersionRow::get(db, &auth.user_id, &slug, version_id)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
            .ok_or(StatusCode::NOT_FOUND)?;
    } else if page.deployed_version_id.is_none() {
        return Err(StatusCode::NOT_FOUND);
    }

    let page_url_path = match version_id.as_deref() {
        Some(version_id) => format!("/p/{username}/{slug}/@v/{version_id}"),
        None => format!("/p/{username}/{slug}"),
    };
    let page_url_path = external_page_url(&state, &page_url_path);
    Ok(Json(PageOpenResponse {
        open_url_path: page_url_path.clone(),
        page_url_path,
        expires_in_seconds: 0,
    }))
}

#[derive(Deserialize)]
struct PageBrowserLoginRequest {
    access_token: String,
    #[serde(default)]
    return_to: Option<String>,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    path_prefix: Option<String>,
}

#[derive(Serialize)]
struct PageBrowserLoginResponse {
    redirect_to: String,
}

struct PageLoginTarget {
    owner_username: String,
    slug: String,
    version_id: Option<String>,
    cookie_path: String,
    return_to: String,
}

#[derive(Deserialize)]
struct PageBrowserSignInQuery {
    state: String,
}

#[derive(Deserialize)]
struct PageBrowserCallbackQuery {
    code: String,
}

fn external_page_url(state: &AppState, path: &str) -> String {
    state
        .page_browser_auth
        .as_ref()
        .map(|config| format!("{}{path}", config.public_base_url))
        .unwrap_or_else(|| path.to_string())
}

fn external_page_cookie_path(state: &AppState, path: &str) -> String {
    state
        .page_browser_auth
        .as_ref()
        .map(|config| format!("{}{path}", config.public_path_prefix))
        .unwrap_or_else(|| path.to_string())
}

fn request_host_matches_origin(headers: &HeaderMap, expected_origin: &str) -> bool {
    let Some((_, authority)) = expected_origin.split_once("://") else {
        return false;
    };
    headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|host| host.eq_ignore_ascii_case(authority))
}

fn parse_page_path_prefix(path_prefix: Option<&str>) -> Result<String, StatusCode> {
    let Some(path_prefix) = path_prefix else {
        return Ok(String::new());
    };
    let path_prefix = path_prefix.trim_end_matches('/');
    if path_prefix.is_empty() {
        return Ok(String::new());
    }
    if path_prefix.len() > 256
        || !path_prefix.starts_with('/')
        || path_prefix.chars().any(char::is_control)
        || !path_prefix.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'-' | b'.' | b'_' | b'~' | b'%')
        })
        || path_prefix
            .split('/')
            .any(|segment| matches!(segment, "." | ".."))
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    Ok(path_prefix.to_string())
}

fn parse_page_login_target(
    return_to: &str,
    path_prefix: Option<&str>,
) -> Result<PageLoginTarget, StatusCode> {
    if return_to.is_empty() || return_to.len() > 4096 || return_to.chars().any(char::is_control) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let uri = return_to
        .parse::<Uri>()
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    if uri.scheme().is_some() || uri.authority().is_some() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let segments = uri.path().split('/').collect::<Vec<_>>();
    if segments.len() < 4
        || !segments[0].is_empty()
        || segments[1] != "p"
        || !is_safe_page_username(segments[2])
        || !is_valid_slug(segments[3])
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    let version_id = if segments.get(4) == Some(&"@v") {
        let version_id = segments.get(5).ok_or(StatusCode::BAD_REQUEST)?;
        if version_id.is_empty()
            || version_id.len() > 128
            || !version_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err(StatusCode::BAD_REQUEST);
        }
        Some((*version_id).to_string())
    } else {
        None
    };
    let cookie_path = match version_id.as_deref() {
        Some(version_id) => {
            format!("/p/{}/{}/@v/{version_id}", segments[2], segments[3])
        }
        None => format!("/p/{}/{}", segments[2], segments[3]),
    };
    let cookie_path = format!("{}{cookie_path}", parse_page_path_prefix(path_prefix)?);
    Ok(PageLoginTarget {
        owner_username: segments[2].to_string(),
        slug: segments[3].to_string(),
        version_id,
        cookie_path,
        return_to: uri
            .path_and_query()
            .map(|value| value.as_str().to_string())
            .ok_or(StatusCode::BAD_REQUEST)?,
    })
}

async fn page_for_login_request(
    db: &crate::db::DbPool,
    request: &PageLoginRequest,
) -> Result<(PageRow, PageVisibility), Response> {
    let page = match PageRow::get(db, &request.user_id, &request.slug).await {
        Ok(Some(page)) if page.generation == request.generation => page,
        Ok(_) => {
            return Err(page_auth_error_response(
                StatusCode::NOT_FOUND,
                "Page not found",
            ))
        }
        Err(error) => {
            tracing::error!("Page browser login lookup failed: {error}");
            return Err(page_auth_error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal error",
            ));
        }
    };
    if let Some(version_id) = request.version_id.as_deref() {
        match PageVersionRow::get(db, &page.user_id, &page.slug, version_id).await {
            Ok(Some(_)) => {}
            Ok(None) => {
                return Err(page_auth_error_response(
                    StatusCode::NOT_FOUND,
                    "Page not found",
                ));
            }
            Err(error) => {
                tracing::error!("Page browser login version lookup failed: {error}");
                return Err(page_auth_error_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal error",
                ));
            }
        }
    } else if page.deployed_version_id.is_none() {
        return Err(page_auth_error_response(
            StatusCode::NOT_FOUND,
            "Page not found",
        ));
    }
    let Some(visibility) = page.visibility_enum() else {
        return Err(page_auth_error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal error",
        ));
    };
    Ok((page, visibility))
}

async fn page_browser_sign_in(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<PageBrowserSignInQuery>,
) -> Response {
    let Some(config) = state.page_browser_auth.as_ref() else {
        return page_auth_error_response(StatusCode::NOT_FOUND, "Page sign-in is not configured");
    };
    if !request_host_matches_origin(&headers, &config.auth_origin) {
        return page_auth_error_response(StatusCode::NOT_FOUND, "Page sign-in is not available");
    }
    let Some(request) = state.page_access_manager.login_request(&query.state) else {
        return page_auth_error_response(StatusCode::GONE, "Page sign-in link expired");
    };
    let db = match require_db(&state) {
        Ok(db) => db,
        Err(status) => return page_auth_error_response(status, "account features disabled"),
    };
    let (_, visibility) = match page_for_login_request(db, &request).await {
        Ok(result) => result,
        Err(response) => return response,
    };
    if visibility == PageVisibility::Public {
        return Redirect::to(&format!("{}{}", config.public_base_url, request.page_path))
            .into_response();
    }
    page_login_form_response(visibility, Some(&query.state), "./client.js")
}

async fn page_browser_login(
    State(state): State<AppState>,
    connect_info: Option<Extension<ConnectInfo<SocketAddr>>>,
    headers: HeaderMap,
    verifier: Option<Extension<crate::identity::IdentityVerifier>>,
    Json(body): Json<PageBrowserLoginRequest>,
) -> Response {
    let db = match require_db(&state) {
        Ok(db) => db,
        Err(status) => return page_auth_error_response(status, "account features disabled"),
    };
    if let Some(config) = state.page_browser_auth.as_ref() {
        if !request_host_matches_origin(&headers, &config.auth_origin) {
            return page_auth_error_response(
                StatusCode::NOT_FOUND,
                "Page sign-in is not available",
            );
        }
        let Some(request_token) = body.state.as_deref() else {
            return page_auth_error_response(StatusCode::BAD_REQUEST, "missing Page sign-in state");
        };
        let Some(request) = state.page_access_manager.login_request(request_token) else {
            return page_auth_error_response(StatusCode::GONE, "Page sign-in link expired");
        };
        let (page, visibility) = match page_for_login_request(db, &request).await {
            Ok(result) => result,
            Err(response) => return response,
        };
        if visibility == PageVisibility::Public {
            return Json(PageBrowserLoginResponse {
                redirect_to: format!("{}{}", config.public_base_url, request.page_path),
            })
            .into_response();
        }
        let viewer = match crate::routes::auth::verify_identity_credentials(
            &state,
            connect_info.map(|Extension(ConnectInfo(addr))| addr),
            &headers,
            &body.access_token,
            verifier.as_ref().map(|v| &v.0),
        )
        .await
        {
            Ok(viewer) => viewer,
            Err(error) => return error.into_response(),
        };
        if visibility == PageVisibility::Private && viewer.user_id != page.user_id {
            return page_auth_error_response(
                StatusCode::FORBIDDEN,
                "account does not have access to this Page",
            );
        }
        let code = match state
            .page_access_manager
            .issue_login_exchange(request_token, viewer.user_id)
        {
            Ok(Some(code)) => code,
            Ok(None) => {
                return page_auth_error_response(StatusCode::GONE, "Page sign-in link expired");
            }
            Err(status) => {
                return page_auth_error_response(status, "unable to create Page session");
            }
        };
        return (
            [(header::CACHE_CONTROL, "no-store")],
            Json(PageBrowserLoginResponse {
                redirect_to: format!(
                    "{}/api/page-auth/callback?code={code}",
                    config.public_base_url
                ),
            }),
        )
            .into_response();
    }

    let Some(return_to) = body.return_to.as_deref() else {
        return page_auth_error_response(StatusCode::BAD_REQUEST, "missing Page return path");
    };
    let target = match parse_page_login_target(return_to, body.path_prefix.as_deref()) {
        Ok(target) => target,
        Err(status) => return page_auth_error_response(status, "invalid Page return path"),
    };
    let page = match PageRow::get_by_username(db, &target.owner_username, &target.slug).await {
        Ok(Some(page)) => page,
        Ok(None) => return page_auth_error_response(StatusCode::NOT_FOUND, "Page not found"),
        Err(error) => {
            tracing::error!("Page browser login lookup failed: {error}");
            return page_auth_error_response(StatusCode::INTERNAL_SERVER_ERROR, "internal error");
        }
    };
    if let Some(version_id) = target.version_id.as_deref() {
        match PageVersionRow::get(db, &page.user_id, &page.slug, version_id).await {
            Ok(Some(_)) => {}
            Ok(None) => return page_auth_error_response(StatusCode::NOT_FOUND, "Page not found"),
            Err(error) => {
                tracing::error!("Page browser login version lookup failed: {error}");
                return page_auth_error_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal error",
                );
            }
        }
    } else if page.deployed_version_id.is_none() {
        return page_auth_error_response(StatusCode::NOT_FOUND, "Page not found");
    }

    let visibility = match page.visibility_enum() {
        Some(visibility) => visibility,
        None => {
            return page_auth_error_response(StatusCode::INTERNAL_SERVER_ERROR, "internal error");
        }
    };
    if visibility == PageVisibility::Public {
        return (
            [(header::CACHE_CONTROL, "no-store")],
            Json(PageBrowserLoginResponse {
                redirect_to: target.return_to,
            }),
        )
            .into_response();
    }

    let viewer = match crate::routes::auth::verify_identity_credentials(
        &state,
        connect_info.map(|Extension(ConnectInfo(addr))| addr),
        &headers,
        &body.access_token,
        verifier.as_ref().map(|v| &v.0),
    )
    .await
    {
        Ok(viewer) => viewer,
        Err(error) => return error.into_response(),
    };
    if visibility == PageVisibility::Private && viewer.user_id != page.user_id {
        return page_auth_error_response(
            StatusCode::FORBIDDEN,
            "account does not have access to this Page",
        );
    }

    let grant = match state.page_access_manager.issue_browser_grant(
        page.user_id,
        viewer.user_id,
        target.slug,
        page.generation,
        target.version_id,
    ) {
        Ok(grant) => grant,
        Err(status) => return page_auth_error_response(status, "unable to create Page session"),
    };
    let cookie = format!(
        "{PAGE_ACCESS_COOKIE}={grant}; Path={}; Max-Age={}; HttpOnly; SameSite=Lax{}",
        target.cookie_path,
        PAGE_BROWSER_GRANT_TTL.as_secs(),
        if request_used_https(&headers) {
            "; Secure"
        } else {
            ""
        }
    );
    let mut response = Json(PageBrowserLoginResponse {
        redirect_to: target.return_to,
    })
    .into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&cookie).expect("validated Page cookie must be a valid header"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn page_browser_callback(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<PageBrowserCallbackQuery>,
) -> Response {
    let Some(config) = state.page_browser_auth.as_ref() else {
        return page_auth_error_response(StatusCode::NOT_FOUND, "Page sign-in is not configured");
    };
    if !request_host_matches_origin(&headers, &config.public_origin) {
        return page_auth_error_response(
            StatusCode::NOT_FOUND,
            "Page sign-in callback is not available",
        );
    }
    if query.code.len() != 64 || !query.code.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return page_auth_error_response(StatusCode::BAD_REQUEST, "invalid Page sign-in code");
    }
    let exchange = match state
        .page_access_manager
        .consume_login_exchange(&query.code)
    {
        Ok(Some(exchange)) => exchange,
        Ok(None) => {
            return page_auth_error_response(StatusCode::GONE, "Page sign-in code expired");
        }
        Err(status) => {
            return page_auth_error_response(status, "unable to complete Page sign-in");
        }
    };
    let db = match require_db(&state) {
        Ok(db) => db,
        Err(status) => return page_auth_error_response(status, "account features disabled"),
    };
    let (page, visibility) = match page_for_login_request(db, &exchange.request).await {
        Ok(result) => result,
        Err(response) => return response,
    };
    if visibility == PageVisibility::Private && exchange.viewer_user_id != page.user_id {
        return page_auth_error_response(
            StatusCode::FORBIDDEN,
            "account does not have access to this Page",
        );
    }
    let grant = match state.page_access_manager.issue_browser_grant(
        page.user_id,
        exchange.viewer_user_id,
        exchange.request.slug,
        page.generation,
        exchange.request.version_id,
    ) {
        Ok(grant) => grant,
        Err(status) => return page_auth_error_response(status, "unable to create Page session"),
    };
    let cookie = format!(
        "{PAGE_ACCESS_COOKIE}={grant}; Path={}; Max-Age={}; HttpOnly; SameSite=Lax{}",
        exchange.request.cookie_path,
        PAGE_BROWSER_GRANT_TTL.as_secs(),
        if config.public_base_url.starts_with("https://") {
            "; Secure"
        } else {
            ""
        }
    );
    let return_to = format!("{}{}", config.public_base_url, exchange.request.page_path);
    let mut response = Redirect::to(&return_to).into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&cookie).expect("validated Page cookie must be a valid header"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn page_auth_error_response(status: StatusCode, error: &str) -> Response {
    (
        status,
        Json(crate::routes::auth::ErrorResponse {
            error: error.to_string(),
            retry_after_secs: None,
        }),
    )
        .into_response()
}

const PAGE_AUTH_CLIENT_JS: &str = include_str!("page_auth_client.bundle.js");

async fn page_auth_client_script(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if state
        .page_browser_auth
        .as_ref()
        .is_some_and(|config| !request_host_matches_origin(&headers, &config.auth_origin))
    {
        return page_auth_error_response(StatusCode::NOT_FOUND, "Page sign-in is not available");
    }
    let mut response = PAGE_AUTH_CLIENT_JS.into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/javascript; charset=utf-8"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-cache, max-age=0"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}

fn page_login_form_response(
    visibility: PageVisibility,
    login_state: Option<&str>,
    client_script: &str,
) -> Response {
    let access_description = match visibility {
        PageVisibility::Private => {
            "仅页面所有者账号可以访问。 Only the Page owner account can continue."
        }
        PageVisibility::Relay => {
            "此中继的任意账号均可访问。 Any account on this relay can continue."
        }
        PageVisibility::Public => "",
    };
    let login_state_attribute = login_state
        .map(|state| format!(r#" data-page-login-state="{state}""#))
        .unwrap_or_default();
    secure_page_html_response(
        if login_state.is_some() {
            StatusCode::OK
        } else {
            StatusCode::UNAUTHORIZED
        },
        format!(
            r#"<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>需要登录 · OpenBitFun Page</title>
  <style>{}</style>
</head>
<body>
  <main>
    <div class="mark" aria-hidden="true">B</div>
    <p class="eyebrow">OPENBITFUN PAGE</p>
    <h1>登录后访问</h1>
    <p>此页面受访问权限保护，请使用邮箱或 GitHub 登录。</p>
    <p class="secondary">This Page is protected. Sign in with your email or GitHub account.</p>
    <p class="access">{access_description}</p>
    <form data-page-login-form{login_state_attribute}>
      <p data-page-login-error class="error" role="alert" hidden></p>
      <button data-page-login-submit class="submit" type="submit">使用邮箱或 GitHub 登录 · Sign in with email or GitHub</button>
    </form>
    <p class="note">使用 OpenBitFun 统一账号登录。</p>
    <noscript><p class="error">登录需要启用 JavaScript。 JavaScript is required to sign in.</p></noscript>
  </main>
  <script src="{client_script}" defer></script>
</body>
</html>"#,
            PAGE_ACCESS_HTML_STYLE
        ),
    )
}

fn page_login_required_response(
    state: &AppState,
    page: &PageWithUsername,
    visibility: PageVisibility,
    username: &str,
    version_id: Option<&str>,
) -> Result<Response, StatusCode> {
    let page_path = match version_id {
        Some(version_id) => format!("/p/{username}/{}/@v/{version_id}", page.slug),
        None => format!("/p/{username}/{}", page.slug),
    };
    let Some(config) = state.page_browser_auth.as_ref() else {
        let client_script = if version_id.is_some() {
            "../../../../api/page-auth/client.js"
        } else {
            "../../api/page-auth/client.js"
        };
        return Ok(page_login_form_response(visibility, None, client_script));
    };
    let cookie_path = external_page_cookie_path(state, &page_path);
    let login_state = state.page_access_manager.issue_login_request(
        page.user_id.clone(),
        page.slug.clone(),
        page.generation.clone(),
        version_id.map(str::to_string),
        page_path,
        cookie_path,
    )?;
    let mut response = Redirect::temporary(&format!(
        "{}/api/page-auth/sign-in?state={login_state}",
        config.auth_base_url
    ))
    .into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

fn secure_page_html_response(status: StatusCode, html: String) -> Response {
    let mut response = html.into_response();
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, max-age=0"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        ),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert("x-frame-options", HeaderValue::from_static("DENY"));
    response
}

const PAGE_ACCESS_HTML_STYLE: &str = r#"
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
*{box-sizing:border-box}
body{min-height:100vh;margin:0;display:grid;place-items:center;padding:24px;background:#101114;color:#f4f5f7}
main{width:min(100%,460px);padding:32px;border:1px solid #32353c;border-radius:16px;background:#1a1c21;box-shadow:0 18px 60px rgba(0,0,0,.32)}
.mark{display:grid;place-items:center;width:44px;height:44px;margin-bottom:24px;border-radius:12px;background:#4f8cff;color:white;font-size:20px;font-weight:700;box-shadow:0 10px 28px rgba(79,140,255,.28)}
.eyebrow{margin:0 0 8px;color:#77a7ff;font-size:12px;font-weight:700;letter-spacing:.12em}
h1{margin:0 0 14px;font-size:24px;line-height:1.3}
p{margin:0;color:#b5b8c0;font-size:14px;line-height:1.7}
.secondary{margin-top:8px;color:#838791;font-size:13px}
.access{margin-top:18px;padding:10px 12px;border:1px solid #343a46;border-radius:8px;background:#20242c;color:#cbd6eb;font-size:12px}
code{padding:2px 6px;border:1px solid #3a3e47;border-radius:6px;background:#22252b;color:#dce7ff}
form{margin-top:26px}
.field{display:block;margin-top:16px;color:#d7d9df;font-size:13px;font-weight:600}
.field:first-child{margin-top:0}
.field small{margin-left:5px;color:#777c87;font-size:11px;font-weight:500}
input{width:100%;height:42px;margin-top:7px;padding:0 12px;border:1px solid #3a3e47;border-radius:8px;outline:none;background:#15171b;color:#f4f5f7;font:inherit}
input:focus{border-color:#5d96ff;box-shadow:0 0 0 3px rgba(79,140,255,.18)}
.password{position:relative;display:block}
.password input{padding-right:60px}
button{border:0;font:inherit;cursor:pointer}
.toggle{position:absolute;right:6px;bottom:5px;height:32px;padding:0 8px;background:transparent;color:#8fb6ff;font-size:12px}
.submit{width:100%;min-height:44px;margin-top:20px;border-radius:9px;background:#4f8cff;color:white;font-weight:650}
.submit:hover{background:#68a0ff}
.submit:disabled{cursor:wait;opacity:.72}
button:focus-visible{outline:3px solid rgba(104,160,255,.4);outline-offset:3px}
button span{margin-left:6px;font-size:12px;font-weight:500;opacity:.78}
.error{margin-top:12px;color:#ff8c8c;font-size:12px}
.note{margin-top:14px;color:#737782;font-size:12px;text-align:center}
"#;

fn request_used_https(headers: &HeaderMap) -> bool {
    headers
        .get("forwarded")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value
                .split(';')
                .any(|part| part.trim().eq_ignore_ascii_case("proto=https"))
        })
        || headers
            .get("x-forwarded-proto")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| {
                value
                    .split(',')
                    .next()
                    .is_some_and(|proto| proto.trim().eq_ignore_ascii_case("https"))
            })
}

fn is_safe_page_username(username: &str) -> bool {
    !username.is_empty()
        && username.len() <= 128
        && username
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

async fn list_pages(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<PageInfo>>, StatusCode> {
    let auth = validate_auth(&state, &headers).await?;
    let db = require_db(&state)?;
    let pages = PageRow::list_for_user(db, &auth.user_id)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let username = UserRow::find_by_username_for_user_id(db, &auth.user_id)
        .await
        .ok()
        .flatten()
        .unwrap_or_default();

    let mut infos = Vec::new();
    for p in pages {
        // One-time legacy migration: old room without versions.
        maybe_migrate_legacy_page(&state, &p).await;
        let _lifecycle_guard = state
            .page_execution_guard
            .acquire_page_read(&p.user_id, &p.slug)
            .await;
        let page = PageRow::get(db, &p.user_id, &p.slug)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        // A row deleted after the initial list query must not be resurrected
        // in the response from the stale in-memory `p` snapshot.
        if let Some(page) = page {
            infos.push(page_to_info(&state, &page, &username));
        }
    }
    Ok(Json(infos))
}

async fn check_page_files(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CheckPageFilesRequest>,
) -> Result<Json<CheckPageFilesResponse>, StatusCode> {
    let auth = validate_auth(&state, &headers).await?;
    let db = require_db(&state)?;
    if !is_valid_slug(&body.slug)
        || body
            .upload_id
            .as_deref()
            .is_some_and(|upload_id| !is_valid_page_upload_id(upload_id))
        || body
            .expected_generation
            .as_deref()
            .is_some_and(|generation| !is_valid_page_generation(generation))
    {
        return Err(StatusCode::BAD_REQUEST);
    }

    let mut total_bytes: u64 = 0;
    let mut manifest = HashMap::with_capacity(body.files.len());
    if body.files.is_empty() || body.files.len() > MAX_PAGE_FILES {
        return Err(StatusCode::BAD_REQUEST);
    }
    for entry in &body.files {
        if crate::validated_asset_relative_path(&entry.path).is_err()
            || !crate::is_valid_content_hash(&entry.hash)
        {
            return Err(StatusCode::BAD_REQUEST);
        }
        if entry.size > MAX_FILE_BYTES {
            return Err(StatusCode::PAYLOAD_TOO_LARGE);
        }
        total_bytes = total_bytes.saturating_add(entry.size);
        if manifest
            .insert(entry.path.clone(), entry.hash.clone())
            .is_some()
        {
            return Err(StatusCode::BAD_REQUEST);
        }
    }
    if total_bytes > MAX_PAGE_BYTES {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }

    let existing = PageRow::get(db, &auth.user_id, &body.slug)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let (expected_generation, create) = resolve_upload_generation_intent(
        existing.as_ref(),
        body.expected_generation.as_deref(),
        body.create,
    )
    .ok_or(StatusCode::CONFLICT)?;
    if existing.is_none() {
        let count = PageRow::count_for_user(db, &auth.user_id)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        if count >= MAX_PAGES_PER_USER {
            return Err(StatusCode::TOO_MANY_REQUESTS);
        }
    }

    for stale_draft in state
        .page_upload_manager
        .prune_expired(Instant::now())
        .await
    {
        state.asset_store.cleanup_room(&stale_draft);
    }

    let page_key = page_upload_session_key(&auth.user_id, &body.slug);
    let _page_guard = state.page_upload_manager.lock_for(&page_key).lock().await;
    let current_page = PageRow::get(db, &auth.user_id, &body.slug)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if !generation_intent_matches(
        current_page.as_ref(),
        expected_generation.as_deref(),
        create,
    ) {
        return Err(StatusCode::CONFLICT);
    }
    let draft_key = body.upload_id.as_deref().map_or_else(
        || page_draft_asset_key(&auth.user_id, &body.slug),
        |upload_id| page_upload_draft_key(&auth.user_id, &body.slug, upload_id),
    );
    if let Some((_, previous)) = state.page_upload_manager.sessions.remove(&page_key) {
        state.asset_store.cleanup_room(&previous.draft_key);
    }
    // Reclaim upload-specific drafts left by a prior process crash. The
    // in-memory store uses exact namespaces (the active one was removed
    // above); the disk store recursively clears this Page's draft subtree.
    state
        .asset_store
        .cleanup_room(&page_draft_asset_key(&auth.user_id, &body.slug));
    // A retry using the same upload id must also start from the submitted
    // manifest, never from partial mappings left by the failed attempt.
    state.asset_store.cleanup_room(&draft_key);
    let asset_store = Arc::clone(&state.asset_store);
    let processing_draft_key = draft_key.clone();
    let response_upload_id = body.upload_id.clone();
    let response_generation = expected_generation.clone();
    let response_create = create;
    let response = tokio::task::spawn_blocking(move || {
        process_check_page_files(
            asset_store,
            &processing_draft_key,
            response_upload_id,
            response_generation,
            response_create,
            body.files,
        )
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)??;

    let _capacity_guard = state
        .page_upload_manager
        .capacity_lock
        .lock()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let user_sessions = state
        .page_upload_manager
        .sessions
        .iter()
        .filter(|entry| entry.user_id == auth.user_id)
        .count();
    if state.page_upload_manager.sessions.len() >= MAX_PAGE_UPLOAD_SESSIONS
        || user_sessions >= MAX_PAGE_UPLOAD_SESSIONS_PER_USER
    {
        state.asset_store.cleanup_room(&draft_key);
        return Err(StatusCode::TOO_MANY_REQUESTS);
    }
    state.page_upload_manager.sessions.insert(
        page_key,
        PageUploadSession {
            user_id: auth.user_id,
            upload_id: body.upload_id.clone(),
            draft_key,
            manifest,
            finalized: false,
            title: None,
            visibility: None,
            expected_generation,
            create,
            expires_at: Instant::now() + PAGE_UPLOAD_SESSION_TTL,
        },
    );
    Ok(Json(response))
}

async fn upload_page_files(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<UploadPageFilesRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let auth = validate_auth(&state, &headers).await?;
    let db = require_db(&state)?;
    if !is_valid_slug(&body.slug)
        || body
            .upload_id
            .as_deref()
            .is_some_and(|upload_id| !is_valid_page_upload_id(upload_id))
        || body
            .expected_generation
            .as_deref()
            .is_some_and(|generation| !is_valid_page_generation(generation))
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    if !body.title.is_empty() && !is_valid_page_title(&body.title) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let visibility = PageVisibility::parse(&body.visibility).ok_or(StatusCode::BAD_REQUEST)?;

    for (rel_path, entry) in &body.files {
        if crate::validated_asset_relative_path(rel_path).is_err()
            || !crate::is_valid_content_hash(&entry.hash)
        {
            return Err(StatusCode::BAD_REQUEST);
        }
        let max_encoded_file_bytes = MAX_FILE_BYTES.div_ceil(3).saturating_mul(4);
        if entry.content.len() as u64 > max_encoded_file_bytes {
            return Err(StatusCode::PAYLOAD_TOO_LARGE);
        }
    }

    let slug = body.slug.clone();
    let upload_id = body.upload_id.clone();
    let finalize = body.finalize;
    let page_key = page_upload_session_key(&auth.user_id, &slug);
    let _page_guard = state.page_upload_manager.lock_for(&page_key).lock().await;
    let session = state
        .page_upload_manager
        .sessions
        .get(&page_key)
        .map(|entry| entry.value().clone())
        .ok_or(StatusCode::CONFLICT)?;
    if session.upload_id != upload_id
        || !upload_request_matches_session_intent(
            body.expected_generation.as_deref(),
            body.create,
            &session,
        )
    {
        return Err(StatusCode::CONFLICT);
    }
    if session.expires_at <= Instant::now() {
        state.page_upload_manager.sessions.remove(&page_key);
        state.asset_store.cleanup_room(&session.draft_key);
        return Err(StatusCode::GONE);
    }
    for (path, entry) in &body.files {
        if session.manifest.get(path) != Some(&entry.hash) {
            return Err(StatusCode::CONFLICT);
        }
    }

    let existing = PageRow::get(db, &auth.user_id, &slug)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if !generation_intent_matches(
        existing.as_ref(),
        session.expected_generation.as_deref(),
        session.create,
    ) {
        return Err(StatusCode::CONFLICT);
    }
    if finalize && existing.is_none() {
        let count = PageRow::count_for_user(db, &auth.user_id)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        if count >= MAX_PAGES_PER_USER {
            return Err(StatusCode::TOO_MANY_REQUESTS);
        }
    }

    let title = if body.title.is_empty() {
        existing
            .as_ref()
            .map(|p| p.title.clone())
            .unwrap_or_else(|| slug.clone())
    } else {
        body.title.clone()
    };
    let draft_key = session.draft_key.clone();
    let asset_store = Arc::clone(&state.asset_store);
    let files = body.files;
    let stored = tokio::task::spawn_blocking(move || {
        process_upload_page_files(asset_store, &draft_key, files)
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)??;

    let mut active = state
        .page_upload_manager
        .sessions
        .get_mut(&page_key)
        .ok_or(StatusCode::CONFLICT)?;
    if active.upload_id != upload_id
        || active.expected_generation != session.expected_generation
        || active.create != session.create
    {
        return Err(StatusCode::CONFLICT);
    }
    // Every accepted batch renews the upload lease. Long but progressing
    // uploads must not expire relative to the initial manifest check.
    active.expires_at = Instant::now() + PAGE_UPLOAD_SESSION_TTL;

    if finalize {
        let actual_manifest = state
            .asset_store
            .list_room_entries(&session.draft_key)
            .into_iter()
            .collect::<HashMap<_, _>>();
        if actual_manifest != session.manifest {
            return Err(StatusCode::CONFLICT);
        }
        active.finalized = true;
        active.title = Some(title);
        active.visibility = Some(visibility);
    }
    drop(active);

    Ok(Json(serde_json::json!({
        "status": "ok",
        "files_stored": stored,
        "slug": slug,
        "upload_id": upload_id,
        "draft": true,
        "finalize": finalize,
    })))
}

async fn freeze_version(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(slug): Path<String>,
    Json(body): Json<FreezeVersionRequest>,
) -> Result<Json<VersionInfo>, StatusCode> {
    let auth = validate_auth(&state, &headers).await?;
    let db = require_db(&state)?;
    if !is_valid_slug(&slug)
        || body
            .upload_id
            .as_deref()
            .is_some_and(|upload_id| !is_valid_page_upload_id(upload_id))
        || body
            .expected_generation
            .as_deref()
            .is_some_and(|generation| !is_valid_page_generation(generation))
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    if (!body.title.is_empty() && !is_valid_page_title(&body.title))
        || !is_valid_page_note(&body.note)
    {
        return Err(StatusCode::BAD_REQUEST);
    }

    let page_key = page_upload_session_key(&auth.user_id, &slug);
    let _page_guard = state.page_upload_manager.lock_for(&page_key).lock().await;
    // A completed freeze consumes its in-memory upload session. Persisting the
    // source upload id with the immutable version lets the exact same request
    // recover its original response after a lost HTTP response or relay restart.
    if let Some(upload_id) = body.upload_id.as_deref() {
        if let Some(version) =
            PageVersionRow::get_by_source_upload_id(db, &auth.user_id, &slug, upload_id)
                .await
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        {
            let page = PageRow::get(db, &auth.user_id, &slug)
                .await
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
                .ok_or(StatusCode::CONFLICT)?;
            let username = UserRow::find_by_username_for_user_id(db, &auth.user_id)
                .await
                .ok()
                .flatten()
                .unwrap_or_default();
            return Ok(Json(VersionInfo {
                generation: page.generation,
                version_id: version.version_id.clone(),
                title: version.title,
                file_count: version.file_count,
                total_bytes: version.total_bytes,
                has_worker: version.has_worker != 0,
                note: version.note,
                created_at: version.created_at,
                deployed: page.deployed_version_id.as_deref() == Some(version.version_id.as_str()),
                preview_url_path: external_page_url(
                    &state,
                    &format!("/p/{username}/{slug}/@v/{}", version.version_id),
                ),
            }));
        }
    }
    let session = state
        .page_upload_manager
        .sessions
        .get(&page_key)
        .map(|entry| entry.value().clone())
        .ok_or(StatusCode::CONFLICT)?;
    if session.upload_id != body.upload_id
        || !upload_request_matches_session_intent(
            body.expected_generation.as_deref(),
            body.create,
            &session,
        )
        || !session.finalized
    {
        return Err(StatusCode::CONFLICT);
    }
    if session.expires_at <= Instant::now() {
        state.page_upload_manager.sessions.remove(&page_key);
        state.asset_store.cleanup_room(&session.draft_key);
        return Err(StatusCode::GONE);
    }

    let _lifecycle_guard = state
        .page_execution_guard
        .acquire_page_write(&auth.user_id, &slug)
        .await;

    let current_page = PageRow::get(db, &auth.user_id, &slug)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if !generation_intent_matches(
        current_page.as_ref(),
        session.expected_generation.as_deref(),
        session.create,
    ) {
        return Err(StatusCode::CONFLICT);
    }
    // Content-only updates must not restore stale metadata if another device
    // renames the Page or restricts access during the upload. All metadata
    // writers take this same lifecycle lease, so the check holds through save.
    if body.expected_visibility.as_ref().is_some_and(|expected| {
        current_page.as_ref().map(|page| &page.visibility) != Some(expected)
    }) || body
        .expected_title
        .as_ref()
        .is_some_and(|expected| current_page.as_ref().map(|page| &page.title) != Some(expected))
    {
        return Err(StatusCode::CONFLICT);
    }

    let count = PageVersionRow::count_for_page(db, &auth.user_id, &slug)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if count >= MAX_VERSIONS_PER_PAGE {
        return Err(StatusCode::TOO_MANY_REQUESTS);
    }

    let draft_key = session.draft_key.clone();
    if !state.asset_store.has_room_files(&draft_key) {
        return Err(StatusCode::BAD_REQUEST);
    }

    let version_id = new_page_version_id();
    let version_key = page_version_asset_key(&auth.user_id, &slug, &version_id);
    let asset_store = Arc::clone(&state.asset_store);
    let draft_key_c = draft_key.clone();
    let version_key_c = version_key.clone();
    let copied =
        tokio::task::spawn_blocking(move || asset_store.copy_room(&draft_key_c, &version_key_c))
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if copied.is_err() {
        state.asset_store.cleanup_room(&version_key);
        return Err(StatusCode::INTERNAL_SERVER_ERROR);
    }

    let entries = state.asset_store.list_room_entries(&version_key);
    let has_worker = entries.iter().any(|(p, _)| p == WORKER_ENTRY_PATH);
    let has_index = entries.iter().any(|(p, _)| p == "index.html");
    if !has_worker && !has_index {
        state.asset_store.cleanup_room(&version_key);
        return Err(StatusCode::BAD_REQUEST);
    }

    // Derive version stats from the actual stored files; never trust
    // client-reported file_count/total_bytes for quota accounting.
    let file_count = entries.len() as i64;
    let total_bytes = state.asset_store.room_total_bytes(&version_key);
    if total_bytes > MAX_PAGE_BYTES {
        state.asset_store.cleanup_room(&version_key);
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    let total_bytes = total_bytes as i64;
    let session_title = session.title.clone().ok_or(StatusCode::CONFLICT)?;
    let visibility = session.visibility.ok_or(StatusCode::CONFLICT)?;
    let title = if body.title.is_empty() {
        session_title
    } else {
        body.title.clone()
    };

    let save_outcome = PageRow::save_version_with_meta(
        db,
        &auth.user_id,
        &slug,
        visibility,
        &title,
        &version_id,
        file_count,
        total_bytes,
        has_worker,
        &body.note,
        body.upload_id.as_deref(),
        MAX_PAGES_PER_USER,
        MAX_VERSIONS_PER_PAGE,
        session.expected_generation.as_deref(),
        session.create,
    )
    .await;
    match save_outcome {
        Ok(SavePageVersionOutcome::Saved) => {}
        Ok(
            SavePageVersionOutcome::PageLimitReached | SavePageVersionOutcome::VersionLimitReached,
        ) => {
            state.asset_store.cleanup_room(&version_key);
            return Err(StatusCode::TOO_MANY_REQUESTS);
        }
        Ok(SavePageVersionOutcome::GenerationMismatch) => {
            state.asset_store.cleanup_room(&version_key);
            return Err(StatusCode::CONFLICT);
        }
        Err(_) => {
            state.asset_store.cleanup_room(&version_key);
            return Err(StatusCode::INTERNAL_SERVER_ERROR);
        }
    }

    // Consume the exact finalized upload session after a successful freeze.
    state.page_upload_manager.sessions.remove(&page_key);
    state.asset_store.cleanup_room(&draft_key);

    let username = UserRow::find_by_username_for_user_id(db, &auth.user_id)
        .await
        .ok()
        .flatten()
        .unwrap_or_default();
    let generation = PageRow::get(db, &auth.user_id, &slug)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::CONFLICT)?
        .generation;

    Ok(Json(VersionInfo {
        generation,
        version_id: version_id.clone(),
        title,
        file_count,
        total_bytes,
        has_worker,
        note: body.note,
        created_at: chrono::Utc::now().timestamp(),
        deployed: false,
        preview_url_path: external_page_url(
            &state,
            &format!("/p/{username}/{slug}/@v/{version_id}"),
        ),
    }))
}

async fn list_versions(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(slug): Path<String>,
    Query(query): Query<ExpectedGenerationQuery>,
) -> Result<Json<Vec<VersionInfo>>, StatusCode> {
    let auth = validate_auth(&state, &headers).await?;
    let db = require_db(&state)?;
    if !is_valid_slug(&slug) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let expected_generation =
        validate_optional_expected_generation(query.expected_generation.as_deref())?;
    // Legacy migration itself needs the write lease. Keep it through the
    // Page/version snapshot so an omitted generation is bound exactly once
    // and cannot drift across a local delete/recreate transition.
    let _lifecycle_guard = state
        .page_execution_guard
        .acquire_page_write(&auth.user_id, &slug)
        .await;
    let page = bind_page_generation_locked(db, &auth.user_id, &slug, expected_generation).await?;
    let bound_generation = page.generation.clone();
    maybe_migrate_legacy_page_locked(&state, &auth.user_id, &slug, &bound_generation).await;
    // The migration is generation-fenced in SQLite. Re-read before assembling
    // the response as a second guard against another relay process replacing
    // the Page while the migration performed storage work.
    let page =
        bind_page_generation_locked(db, &auth.user_id, &slug, Some(&bound_generation)).await?;
    let versions = PageVersionRow::list_for_page(db, &auth.user_id, &slug)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let username = UserRow::find_by_username_for_user_id(db, &auth.user_id)
        .await
        .ok()
        .flatten()
        .unwrap_or_default();
    let deployed = page.deployed_version_id.clone();

    Ok(Json(
        versions
            .into_iter()
            .map(|v| VersionInfo {
                generation: page.generation.clone(),
                preview_url_path: external_page_url(
                    &state,
                    &format!("/p/{username}/{slug}/@v/{}", v.version_id),
                ),
                deployed: deployed.as_deref() == Some(v.version_id.as_str()),
                version_id: v.version_id,
                title: v.title,
                file_count: v.file_count,
                total_bytes: v.total_bytes,
                has_worker: v.has_worker != 0,
                note: v.note,
                created_at: v.created_at,
            })
            .collect(),
    ))
}

async fn deploy_version(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(slug): Path<String>,
    Json(body): Json<DeployRequest>,
) -> Result<Json<PageInfo>, StatusCode> {
    let auth = validate_auth(&state, &headers).await?;
    let db = require_db(&state)?;
    let expected_generation =
        validate_optional_expected_generation(body.expected_generation.as_deref())?;
    if !is_valid_slug(&slug) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let _lifecycle_guard = state
        .page_execution_guard
        .acquire_page_write(&auth.user_id, &slug)
        .await;
    let page = bind_page_generation_locked(db, &auth.user_id, &slug, expected_generation).await?;
    let page =
        match PageRow::deploy_version(db, &auth.user_id, &slug, &body.version_id, &page.generation)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        {
            PageMutationOutcome::Applied(page) => page,
            PageMutationOutcome::NotFound => return Err(StatusCode::NOT_FOUND),
            PageMutationOutcome::GenerationMismatch => return Err(StatusCode::CONFLICT),
        };
    let username = UserRow::find_by_username_for_user_id(db, &auth.user_id)
        .await
        .ok()
        .flatten()
        .unwrap_or_default();
    Ok(Json(page_to_info(&state, &page, &username)))
}

async fn unpublish_page(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(slug): Path<String>,
    Query(query): Query<ExpectedGenerationQuery>,
) -> Result<StatusCode, StatusCode> {
    let auth = validate_auth(&state, &headers).await?;
    let db = require_db(&state)?;
    let expected_generation =
        validate_optional_expected_generation(query.expected_generation.as_deref())?;
    if !is_valid_slug(&slug) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let _lifecycle_guard = state
        .page_execution_guard
        .acquire_page_write(&auth.user_id, &slug)
        .await;
    let page = bind_page_generation_locked(db, &auth.user_id, &slug, expected_generation).await?;
    let outcome = PageRow::clear_deployed_version(db, &auth.user_id, &slug, &page.generation)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    match outcome {
        PageMutationOutcome::Applied(()) => {}
        PageMutationOutcome::NotFound => return Err(StatusCode::NOT_FOUND),
        PageMutationOutcome::GenerationMismatch => return Err(StatusCode::CONFLICT),
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_version(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((slug, version_id)): Path<(String, String)>,
    Query(query): Query<ExpectedGenerationQuery>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let auth = validate_auth(&state, &headers).await?;
    let db = require_db(&state)?;
    let expected_generation =
        validate_optional_expected_generation(query.expected_generation.as_deref())?;
    if !is_valid_slug(&slug) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let _lifecycle_guard = state
        .page_execution_guard
        .acquire_page_write(&auth.user_id, &slug)
        .await;
    let page = bind_page_generation_locked(db, &auth.user_id, &slug, expected_generation).await?;
    match PageVersionRow::delete_if_not_deployed(
        db,
        &auth.user_id,
        &slug,
        &version_id,
        &page.generation,
    )
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    {
        DeletePageVersionOutcome::Deleted => {}
        DeletePageVersionOutcome::Deployed => return Err(StatusCode::BAD_REQUEST),
        DeletePageVersionOutcome::NotFound => return Err(StatusCode::NOT_FOUND),
        DeletePageVersionOutcome::GenerationMismatch => return Err(StatusCode::CONFLICT),
    }
    let key = page_version_asset_key(&auth.user_id, &slug, &version_id);
    state.asset_store.cleanup_room(&key);
    Ok(Json(
        serde_json::json!({ "status": "ok", "version_id": version_id }),
    ))
}

async fn update_page(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(slug): Path<String>,
    Json(body): Json<UpdatePageRequest>,
) -> Result<Json<PageInfo>, StatusCode> {
    let auth = validate_auth(&state, &headers).await?;
    let db = require_db(&state)?;
    let expected_generation =
        validate_optional_expected_generation(body.expected_generation.as_deref())?;
    if !is_valid_slug(&slug) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let _lifecycle_guard = state
        .page_execution_guard
        .acquire_page_write(&auth.user_id, &slug)
        .await;
    let page = bind_page_generation_locked(db, &auth.user_id, &slug, expected_generation).await?;
    let previous_visibility = page.visibility.clone();
    let visibility = match body.visibility.as_deref() {
        Some(v) => Some(PageVisibility::parse(v).ok_or(StatusCode::BAD_REQUEST)?),
        None => None,
    };
    if body
        .title
        .as_deref()
        .is_some_and(|title| !is_valid_page_title(title))
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    let page = match PageRow::update_meta(
        db,
        &auth.user_id,
        &slug,
        &page.generation,
        visibility,
        body.title.as_deref(),
    )
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    {
        PageMutationOutcome::Applied(page) => page,
        PageMutationOutcome::NotFound => return Err(StatusCode::NOT_FOUND),
        PageMutationOutcome::GenerationMismatch => return Err(StatusCode::CONFLICT),
    };
    if page.visibility != previous_visibility {
        state.page_access_manager.revoke_page(&auth.user_id, &slug);
    }
    let username = UserRow::find_by_username_for_user_id(db, &auth.user_id)
        .await
        .ok()
        .flatten()
        .unwrap_or_default();
    Ok(Json(page_to_info(&state, &page, &username)))
}

async fn delete_page(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(slug): Path<String>,
    Query(query): Query<ExpectedGenerationQuery>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let auth = validate_auth(&state, &headers).await?;
    let db = require_db(&state)?;
    let expected_generation =
        validate_optional_expected_generation(query.expected_generation.as_deref())?;
    if !is_valid_slug(&slug) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let page_key = page_upload_session_key(&auth.user_id, &slug);
    let _page_guard = state.page_upload_manager.lock_for(&page_key).lock().await;
    let _lifecycle_guard = state
        .page_execution_guard
        .acquire_page_write(&auth.user_id, &slug)
        .await;
    let page = bind_page_generation_locked(db, &auth.user_id, &slug, expected_generation).await?;
    let versions = PageVersionRow::list_for_page(db, &auth.user_id, &slug)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if let Some(store) = &state.page_data {
        store
            .prepare_generation(&auth.user_id, &slug, &page.generation)
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    }
    // Commit the relational deletion first. Filesystem/object cleanup is
    // idempotent, whereas deleting assets before a failed multi-table DB
    // mutation could leave a partially present Page with missing content.
    // Mutable PageData has already been assigned to this Page generation, so a
    // crash after this commit cannot expose it to a recreated Page generation.
    let deleted = PageRow::delete(db, &auth.user_id, &slug, &page.generation)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    match deleted {
        PageMutationOutcome::Applied(()) => {}
        PageMutationOutcome::NotFound => return Err(StatusCode::NOT_FOUND),
        PageMutationOutcome::GenerationMismatch => return Err(StatusCode::CONFLICT),
    }
    state.page_access_manager.revoke_page(&auth.user_id, &slug);
    if let Some((_, active_upload)) = state.page_upload_manager.sessions.remove(&page_key) {
        state.asset_store.cleanup_room(&active_upload.draft_key);
    }
    for v in &versions {
        state.asset_store.cleanup_room(&page_version_asset_key(
            &auth.user_id,
            &slug,
            &v.version_id,
        ));
    }
    state
        .asset_store
        .cleanup_room(&page_draft_asset_key(&auth.user_id, &slug));
    state
        .asset_store
        .cleanup_room(&page_legacy_asset_key(&auth.user_id, &slug));
    if let Some(store) = &state.page_data {
        store.cleanup_page(&auth.user_id, &slug);
    }
    Ok(Json(serde_json::json!({ "status": "ok", "slug": slug })))
}

// ── Serve ───────────────────────────────────────────────────────────────

async fn serve_prod_root(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    Path((username, slug)): Path<(String, String)>,
    body: axum::body::Bytes,
) -> Result<axum::response::Response, StatusCode> {
    serve_page(state, method, headers, &username, &slug, None, "", body).await
}

async fn serve_prod_path(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    Path((username, slug, path)): Path<(String, String, String)>,
    body: axum::body::Bytes,
) -> Result<axum::response::Response, StatusCode> {
    // Guard against treating `@v/...` as production path when catch-all matches wrongly.
    if path.starts_with("@v/") || path == "@v" {
        return Err(StatusCode::NOT_FOUND);
    }
    serve_page(state, method, headers, &username, &slug, None, &path, body).await
}

async fn serve_preview_root(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    Path((username, slug, version_id)): Path<(String, String, String)>,
    body: axum::body::Bytes,
) -> Result<axum::response::Response, StatusCode> {
    serve_page(
        state,
        method,
        headers,
        &username,
        &slug,
        Some(version_id.as_str()),
        "",
        body,
    )
    .await
}

async fn serve_preview_path(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    Path((username, slug, version_id, path)): Path<(String, String, String, String)>,
    body: axum::body::Bytes,
) -> Result<axum::response::Response, StatusCode> {
    serve_page(
        state,
        method,
        headers,
        &username,
        &slug,
        Some(version_id.as_str()),
        &path,
        body,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn serve_page(
    state: AppState,
    method: Method,
    headers: HeaderMap,
    username: &str,
    slug: &str,
    version_override: Option<&str>,
    path: &str,
    body: axum::body::Bytes,
) -> Result<axum::response::Response, StatusCode> {
    if state
        .page_browser_auth
        .as_ref()
        .is_some_and(|config| !request_host_matches_origin(&headers, &config.public_origin))
    {
        return Err(StatusCode::NOT_FOUND);
    }
    let db = require_db(&state)?;
    if !is_valid_slug(slug) || username.is_empty() || username.contains("..") {
        return Err(StatusCode::NOT_FOUND);
    }
    if path.contains("..") {
        return Err(StatusCode::NOT_FOUND);
    }

    let initial_page = PageRow::get_by_username(db, username, slug)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;
    // Legacy migration needs the lifecycle write lock. Modern Pages must stay
    // on the shared serving path: taking that write lock for every production
    // request would serialize traffic behind any running Page Function. Only
    // a row with no deployment, no version, and legacy assets is a migration
    // candidate; the locked helper revalidates the generation and all of these
    // facts before committing.
    let should_migrate_legacy = version_override.is_none()
        && initial_page.deployed_version_id.is_none()
        && PageVersionRow::count_for_page(db, &initial_page.user_id, slug)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
            == 0
        && state
            .asset_store
            .has_room_files(&page_legacy_asset_key(&initial_page.user_id, slug));
    if should_migrate_legacy {
        maybe_migrate_legacy_page_by_ids(
            &state,
            &initial_page.user_id,
            slug,
            &initial_page.generation,
        )
        .await;
    }
    let _lifecycle_guard = state
        .page_execution_guard
        .acquire_page_read(&initial_page.user_id, slug)
        .await;
    // A request may have resolved the Page just before a delete obtained the
    // write lock. Re-resolve under the read lock so it cannot execute stale
    // worker code or write mutable data after deletion/recreation.
    let page = PageRow::get_by_username(db, username, slug)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;
    if let Err(status) = enforce_visibility(&state, &headers, &page, version_override).await {
        if status == StatusCode::UNAUTHORIZED && (method == Method::GET || method == Method::HEAD) {
            let visibility = page
                .visibility_enum()
                .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;
            return page_login_required_response(
                &state,
                &page,
                visibility,
                username,
                version_override,
            );
        }
        return Err(status);
    }

    // Resolve version.
    let version_id = if let Some(v) = version_override {
        v.to_string()
    } else {
        page.deployed_version_id
            .clone()
            .ok_or(StatusCode::NOT_FOUND)?
    };

    let version = PageVersionRow::get(db, &page.user_id, slug, &version_id)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    let asset_key = page_version_asset_key(&page.user_id, slug, &version_id);
    let lookup_path = if path.is_empty() || path.ends_with('/') {
        if path.is_empty() {
            "index.html".to_string()
        } else {
            format!("{path}index.html")
        }
    } else {
        path.to_string()
    };

    if version.has_worker != 0 {
        return serve_with_worker(
            state,
            method,
            headers,
            &page,
            &version,
            &asset_key,
            &lookup_path,
            path,
            body,
        )
        .await;
    }

    // Static-only version.
    if method != Method::GET && method != Method::HEAD {
        return Err(StatusCode::METHOD_NOT_ALLOWED);
    }
    let asset_store = Arc::clone(&state.asset_store);
    let asset_key_io = asset_key.clone();
    let lookup_io = lookup_path.clone();
    let content =
        tokio::task::spawn_blocking(move || asset_store.get_file(&asset_key_io, &lookup_io))
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
            .ok_or(StatusCode::NOT_FOUND)?;

    let mime = mime_from_path(&lookup_path);
    Ok((
        [
            (header::CONTENT_TYPE, mime),
            (header::CACHE_CONTROL, "no-store"),
            (
                header::HeaderName::from_static("x-content-type-options"),
                "nosniff",
            ),
        ],
        axum::body::Body::from(content),
    )
        .into_response())
}

#[allow(clippy::too_many_arguments)]
async fn serve_with_worker(
    state: AppState,
    method: Method,
    headers: HeaderMap,
    page: &PageWithUsername,
    version: &PageVersionRow,
    asset_key: &str,
    lookup_path: &str,
    raw_path: &str,
    body: axum::body::Bytes,
) -> Result<axum::response::Response, StatusCode> {
    if body.len() > crate::page_execution::MAX_PAGE_FUNCTION_REQUEST_BODY_BYTES {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    let _execution_permit = state
        .page_execution_guard
        .try_acquire(&page.user_id, &page.slug)
        .map_err(|_| StatusCode::TOO_MANY_REQUESTS)?;
    let page_data = state.page_data.clone().ok_or(StatusCode::NOT_IMPLEMENTED)?;
    let db = state.db.clone();
    let asset_store = Arc::clone(&state.asset_store);
    let asset_store_fallback = Arc::clone(&state.asset_store);
    let asset_key = asset_key.to_string();
    let lookup_path_owned = lookup_path.to_string();
    let worker_source = {
        let store = Arc::clone(&asset_store);
        let key = asset_key.clone();
        tokio::task::spawn_blocking(move || store.get_file_exact(&key, WORKER_ENTRY_PATH))
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
            .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?
    };
    let worker_source = String::from_utf8(worker_source).map_err(|_| StatusCode::BAD_GATEWAY)?;

    // Never forward credential headers into the page worker: a malicious page
    // owner could persist viewer tokens via env.KV/BLOBS and harvest them.
    let mut req_headers = HashMap::new();
    for (k, v) in headers.iter() {
        if matches!(
            k.as_str(),
            "authorization" | "cookie" | "proxy-authorization"
        ) {
            continue;
        }
        if let Ok(val) = v.to_str() {
            req_headers.insert(k.as_str().to_string(), val.to_string());
        }
    }
    let path_for_req = if raw_path.is_empty() {
        "/".to_string()
    } else {
        format!("/{raw_path}")
    };
    let url = format!(
        "/p/{}/{}/@v/{}{}",
        page.username,
        page.slug,
        version.version_id,
        if raw_path.is_empty() {
            String::new()
        } else {
            format!("/{raw_path}")
        }
    );

    let host = Arc::new(RelayPageHost {
        db,
        page_data,
        user_id: page.user_id.clone(),
        slug: page.slug.clone(),
        generation: page.generation.clone(),
        meta: PageMeta {
            username: page.username.clone(),
            slug: page.slug.clone(),
            version_id: version.version_id.clone(),
            visibility: page.visibility.clone(),
        },
        asset_store,
        asset_key: asset_key.clone(),
    });

    let fetch_req = FetchRequest {
        method: method.as_str().to_string(),
        url,
        path: path_for_req,
        headers: req_headers,
        body: if body.is_empty() {
            None
        } else {
            Some(String::from_utf8_lossy(&body).into_owned())
        },
    };

    let response = tokio::task::spawn_blocking(move || {
        run_fetch(&worker_source, &fetch_req, host, DEFAULT_TIMEOUT)
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    .map_err(|e| {
        tracing::warn!("Page function error: {e}");
        if matches!(e, PageFunctionError::Timeout(_)) {
            StatusCode::GATEWAY_TIMEOUT
        } else {
            StatusCode::BAD_GATEWAY
        }
    })?;

    // If worker returns 404 for document GET, fall back to static assets.
    if response.status == 404 && (method == Method::GET || method == Method::HEAD) {
        let key = asset_key.clone();
        let lookup = lookup_path_owned.clone();
        if let Ok(Some(bytes)) =
            tokio::task::spawn_blocking(move || asset_store_fallback.get_file(&key, &lookup)).await
        {
            let mime = mime_from_path(&lookup_path_owned);
            return Ok((
                [
                    (header::CONTENT_TYPE, mime),
                    (header::CACHE_CONTROL, "no-store"),
                    (
                        header::HeaderName::from_static("x-content-type-options"),
                        "nosniff",
                    ),
                ],
                axum::body::Body::from(bytes),
            )
                .into_response());
        }
    }

    let mut builder = axum::http::Response::builder()
        .status(response.status)
        .header("x-content-type-options", "nosniff")
        // Visibility is mutable while a Page version is immutable. Reusing a
        // previously public cached document after switching to protected
        // visibility would bypass the Relay check entirely.
        .header(header::CACHE_CONTROL, "no-store");
    for (k, v) in response.headers {
        if let (Ok(name), Ok(val)) = (
            axum::http::HeaderName::try_from(k),
            axum::http::HeaderValue::try_from(v),
        ) {
            if should_forward_page_worker_response_header(&name) {
                builder = builder.header(name, val);
            }
        }
    }
    builder
        .body(axum::body::Body::from(response.body))
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

/// Filter worker-controlled response headers that can mutate origin-wide
/// browser policy/state or connection framing. This is defense in depth: Page
/// documents still share an origin with the relay until hosting moves to a
/// dedicated Page origin. Ordinary representation and CORS headers remain
/// available to Page authors.
fn should_forward_page_worker_response_header(name: &axum::http::HeaderName) -> bool {
    !matches!(
        name.as_str(),
        "accept-ch"
            | "alt-svc"
            | "cache-control"
            | "clear-site-data"
            | "connection"
            | "content-length"
            | "critical-ch"
            | "keep-alive"
            | "nel"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "report-to"
            | "reporting-endpoints"
            | "service-worker-allowed"
            | "set-cookie"
            | "set-cookie2"
            | "strict-transport-security"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
            | "x-content-type-options"
    )
}

// ── Helpers ─────────────────────────────────────────────────────────────

fn page_to_info(state: &AppState, page: &PageRow, username: &str) -> PageInfo {
    let url_path = if username.is_empty() || page.deployed_version_id.is_none() {
        String::new()
    } else {
        external_page_url(state, &format!("/p/{username}/{}", page.slug))
    };
    let preview_url_path = page.deployed_version_id.as_ref().map(|v| {
        if username.is_empty() {
            String::new()
        } else {
            external_page_url(state, &format!("/p/{username}/{}/@v/{v}", page.slug))
        }
    });
    PageInfo {
        slug: page.slug.clone(),
        generation: page.generation.clone(),
        visibility: page.visibility.clone(),
        title: page.title.clone(),
        file_count: page.file_count,
        total_bytes: page.total_bytes,
        created_at: page.created_at,
        updated_at: page.updated_at,
        url_path,
        preview_url_path,
        deployed_version_id: page.deployed_version_id.clone(),
    }
}

async fn maybe_migrate_legacy_page(state: &AppState, page: &PageRow) {
    maybe_migrate_legacy_page_by_ids(state, &page.user_id, &page.slug, &page.generation).await;
}

async fn maybe_migrate_legacy_page_by_ids(
    state: &AppState,
    user_id: &str,
    slug: &str,
    expected_generation: &str,
) {
    let _lifecycle_guard = state
        .page_execution_guard
        .acquire_page_write(user_id, slug)
        .await;
    maybe_migrate_legacy_page_locked(state, user_id, slug, expected_generation).await;
}

async fn maybe_migrate_legacy_page_locked(
    state: &AppState,
    user_id: &str,
    slug: &str,
    expected_generation: &str,
) {
    let db = state.db.as_ref();
    let Ok(Some(page)) = PageRow::get(db, user_id, slug).await else {
        return;
    };
    if page.generation != expected_generation {
        return;
    }
    if page.deployed_version_id.is_some() {
        return;
    }
    let Ok(count) = PageVersionRow::count_for_page(db, user_id, slug).await else {
        return;
    };
    if count > 0 {
        return;
    }
    let legacy = page_legacy_asset_key(user_id, slug);
    if !state.asset_store.has_room_files(&legacy) {
        return;
    }
    let version_id = "v1".to_string();
    let version_key = page_version_asset_key(user_id, slug, &version_id);
    let legacy_entries = state
        .asset_store
        .list_room_entries(&legacy)
        .into_iter()
        .collect::<HashMap<_, _>>();
    let target_preexisted = state.asset_store.has_room_files(&version_key);
    if target_preexisted {
        let target_entries = state
            .asset_store
            .list_room_entries(&version_key)
            .into_iter()
            .collect::<HashMap<_, _>>();
        if target_entries != legacy_entries {
            tracing::warn!(
                "Skipped legacy Page migration because synthetic v1 assets already differ: {user_id}/{slug}"
            );
            return;
        }
    } else if state.asset_store.copy_room(&legacy, &version_key).is_err() {
        return;
    }
    let entries = state.asset_store.list_room_entries(&version_key);
    let has_worker = entries.iter().any(|(p, _)| p == WORKER_ENTRY_PATH);
    let migration = PageRow::migrate_legacy_version(
        db,
        user_id,
        slug,
        expected_generation,
        &version_id,
        &page.title,
        page.file_count,
        page.total_bytes,
        has_worker,
    )
    .await;
    if matches!(migration, Ok(PageMutationOutcome::Applied(true))) {
        tracing::info!("Migrated legacy page {user_id}/{slug} to version v1");
        return;
    }

    if !target_preexisted {
        // A concurrent process may have committed the same v1 between the
        // asset copy and our fenced transaction. Preserve the room only when
        // the database now references it; otherwise this attempt owns and
        // cleans the uncommitted synthetic target.
        let target_is_committed = match PageRow::get(db, user_id, slug).await {
            Ok(Some(current)) if current.deployed_version_id.as_deref() == Some(&version_id) => {
                PageVersionRow::get(db, user_id, slug, &version_id)
                    .await
                    .ok()
                    .flatten()
                    .is_some()
            }
            _ => false,
        };
        if !target_is_committed {
            state.asset_store.cleanup_room(&version_key);
        }
    }
}

async fn enforce_visibility(
    state: &AppState,
    headers: &HeaderMap,
    page: &PageWithUsername,
    version_id: Option<&str>,
) -> Result<(), StatusCode> {
    let visibility = page
        .visibility_enum()
        .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;
    match visibility {
        PageVisibility::Public => Ok(()),
        PageVisibility::Relay => {
            if state.page_access_manager.authorizes_page(
                headers,
                &page.user_id,
                &page.slug,
                &page.generation,
                version_id,
            ) || resolve_viewer(state, headers).await.is_ok()
            {
                Ok(())
            } else {
                Err(StatusCode::UNAUTHORIZED)
            }
        }
        PageVisibility::Private => {
            if state.page_access_manager.authorizes_page(
                headers,
                &page.user_id,
                &page.slug,
                &page.generation,
                version_id,
            ) {
                return Ok(());
            }
            match resolve_viewer(state, headers).await {
                Ok(viewer) if viewer.user_id == page.user_id => Ok(()),
                Ok(_) => Err(StatusCode::NOT_FOUND),
                Err(StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) => {
                    Err(StatusCode::UNAUTHORIZED)
                }
                Err(status) => Err(status),
            }
        }
    }
}

async fn resolve_viewer(state: &AppState, headers: &HeaderMap) -> Result<AuthUser, StatusCode> {
    // Only the Authorization header is accepted for viewer auth. Query-string
    // tokens are deliberately unsupported: published pages serve arbitrary
    // same-origin user JS, which could read tokens from `location.search`.
    let token = extract_bearer_token(headers).ok_or(StatusCode::UNAUTHORIZED)?;
    validate_token(state, &token).await
}

fn process_check_page_files(
    asset_store: Arc<dyn WebAssetStore>,
    asset_key: &str,
    upload_id: Option<String>,
    expected_generation: Option<String>,
    create: bool,
    files: Vec<FileManifestEntry>,
) -> Result<CheckPageFilesResponse, StatusCode> {
    let mut needed = Vec::new();
    let mut existing_count = 0usize;
    let total_count = files.len();
    for entry in files {
        if crate::validated_asset_relative_path(&entry.path).is_err()
            || !crate::is_valid_content_hash(&entry.hash)
        {
            needed.push(entry.path);
            continue;
        }
        if asset_store.has_content(&entry.hash) {
            existing_count += 1;
            asset_store
                .map_to_room(asset_key, &entry.path, &entry.hash)
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        } else {
            needed.push(entry.path);
        }
    }
    Ok(CheckPageFilesResponse {
        upload_id,
        expected_generation,
        create,
        needed,
        existing_count,
        total_count,
        freeze_idempotency_supported: true,
        metadata_preconditions_supported: true,
    })
}

fn process_upload_page_files(
    asset_store: Arc<dyn WebAssetStore>,
    asset_key: &str,
    files: HashMap<String, UploadFileEntry>,
) -> Result<usize, StatusCode> {
    // Decode and verify the whole batch before writing anything, then enforce
    // the cumulative draft quota up front. Checking only after storing would
    // let repeated rejected batches bloat the content-addressed store.
    let mut decoded_files: Vec<(String, String, Vec<u8>)> = Vec::with_capacity(files.len());
    let mut batch_bytes: u64 = 0;
    for (rel_path, entry) in files {
        crate::validated_asset_relative_path(&rel_path).map_err(|_| StatusCode::BAD_REQUEST)?;
        if !crate::is_valid_content_hash(&entry.hash) {
            return Err(StatusCode::BAD_REQUEST);
        }
        let decoded = B64
            .decode(&entry.content)
            .map_err(|_| StatusCode::BAD_REQUEST)?;
        if decoded.len() as u64 > MAX_FILE_BYTES {
            return Err(StatusCode::PAYLOAD_TOO_LARGE);
        }
        let actual_hash = hex_sha256(&decoded);
        if actual_hash != entry.hash {
            return Err(StatusCode::BAD_REQUEST);
        }
        batch_bytes = batch_bytes.saturating_add(decoded.len() as u64);
        decoded_files.push((rel_path, actual_hash, decoded));
    }
    if asset_store
        .room_total_bytes(asset_key)
        .saturating_add(batch_bytes)
        > MAX_PAGE_BYTES
    {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }

    let mut stored = 0usize;
    for (rel_path, actual_hash, decoded) in decoded_files {
        if !asset_store.has_content(&actual_hash) {
            asset_store
                .store_content(&actual_hash, decoded)
                .map_err(crate::asset_store_error_status)?;
            stored += 1;
        }
        asset_store
            .map_to_room(asset_key, &rel_path, &actual_hash)
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    }
    Ok(stored)
}

fn hex_sha256(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn mime_from_path(p: &str) -> &'static str {
    match p.rsplit('.').next() {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "application/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("svg") => "image/svg+xml",
        Some("wasm") => "application/wasm",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{connect, page_kv, AuthToken, DeviceRow, PageRow, UserRow};
    use crate::MemoryAssetStore;
    use axum::body::to_bytes;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    #[test]
    fn management_generation_validation_only_normalizes_the_legacy_empty_value() {
        let valid = "0123456789abcdef0123456789abcdef";
        assert_eq!(validate_optional_expected_generation(None).unwrap(), None);
        assert_eq!(
            validate_optional_expected_generation(Some("")).unwrap(),
            None
        );
        assert_eq!(
            validate_optional_expected_generation(Some(valid)).unwrap(),
            Some(valid)
        );
        assert_eq!(
            validate_optional_expected_generation(Some(" ")).unwrap_err(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            validate_optional_expected_generation(Some("not-a-generation")).unwrap_err(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(parse_page_path_prefix(Some("/relay/")).unwrap(), "/relay");
        assert_eq!(
            parse_page_path_prefix(Some("/relay/../admin")).unwrap_err(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            parse_page_path_prefix(Some("/relay; Domain=attacker.invalid")).unwrap_err(),
            StatusCode::BAD_REQUEST
        );
    }

    #[test]
    fn worker_response_headers_cannot_mutate_origin_wide_browser_state() {
        for name in [
            "service-worker-allowed",
            "set-cookie",
            "cache-control",
            "clear-site-data",
            "strict-transport-security",
            "reporting-endpoints",
            "transfer-encoding",
        ] {
            let name = axum::http::HeaderName::from_bytes(name.as_bytes()).unwrap();
            assert!(!should_forward_page_worker_response_header(&name), "{name}");
        }

        for name in ["content-type", "access-control-allow-origin"] {
            let name = axum::http::HeaderName::from_bytes(name.as_bytes()).unwrap();
            assert!(should_forward_page_worker_response_header(&name), "{name}");
        }
    }

    async fn setup_app_with_page_auth(
        page_browser_auth: Option<crate::PageBrowserAuthConfig>,
    ) -> (axum::Router, String, String, Arc<crate::db::DbPool>) {
        let pool = connect(":memory:").await.unwrap();
        let pool = Arc::new(pool);
        UserRow::create(&pool, "101", "alice").await.unwrap();
        UserRow::create(&pool, "102", "bob").await.unwrap();
        DeviceRow::upsert(&pool, "d1", "101", "Laptop", None, None)
            .await
            .unwrap();
        DeviceRow::upsert(&pool, "d2", "102", "Phone", None, None)
            .await
            .unwrap();
        let tok_alice = AuthToken::create(&pool, "101", "d1").await.unwrap();
        let tok_bob = AuthToken::create(&pool, "102", "d2").await.unwrap();
        let tmp = tempfile::tempdir().unwrap();
        let page_data_dir = tmp.path().join("page-data");
        std::mem::forget(tmp);

        let app = crate::build_relay_router_with_page_data_origins_and_page_auth(
            Arc::new(MemoryAssetStore::new()),
            std::time::Instant::now(),
            Arc::clone(&pool),
            "test",
            Some(page_data_dir),
            Vec::new(),
            page_browser_auth,
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let authority_url = format!("http://{}/me", listener.local_addr().unwrap());
        let authority = axum::Router::new().route(
            "/me",
            axum::routing::get(|headers: HeaderMap| async move {
                match headers.get("authorization").and_then(|h| h.to_str().ok()) {
                    Some("Bearer alice") => (
                        StatusCode::OK,
                        Json(serde_json::json!({"user":{"githubId":101,"login":"alice"}})),
                    ),
                    Some("Bearer bob") => (
                        StatusCode::OK,
                        Json(serde_json::json!({"user":{"githubId":102,"login":"bob"}})),
                    ),
                    _ => (
                        StatusCode::UNAUTHORIZED,
                        Json(serde_json::json!({"error":"expired"})),
                    ),
                }
            }),
        );
        tokio::spawn(async move {
            axum::serve(listener, authority).await.unwrap();
        });
        let app = app.layer(Extension(
            crate::identity::IdentityVerifier::with_url(&authority_url).unwrap(),
        ));
        (app, tok_alice.token, tok_bob.token, pool)
    }

    async fn setup_app_with_pool() -> (axum::Router, String, String, Arc<crate::db::DbPool>) {
        setup_app_with_page_auth(None).await
    }

    async fn setup_app() -> (axum::Router, String, String) {
        let (app, alice, bob, _) = setup_app_with_pool().await;
        (app, alice, bob)
    }

    async fn test_page_generation(app: &axum::Router, token: &str, slug: &str) -> Option<String> {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/pages")
                    .header("Authorization", format!("Bearer {token}"))
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let pages: Vec<serde_json::Value> = serde_json::from_slice(&body).unwrap();
        pages.into_iter().find_map(|page| {
            (page["slug"].as_str() == Some(slug))
                .then(|| page["generation"].as_str().map(str::to_string))
                .flatten()
        })
    }

    async fn begin_test_upload(
        app: &axum::Router,
        token: &str,
        slug: &str,
        files: &[(&str, &[u8])],
    ) -> (String, serde_json::Map<String, serde_json::Value>) {
        let upload_id = uuid::Uuid::new_v4().simple().to_string();
        let expected_generation = test_page_generation(app, token, slug).await;
        let create = expected_generation.is_none();
        let mut manifest = Vec::new();
        let mut upload_files = serde_json::Map::new();
        for (path, content) in files {
            let hash = hex_sha256(content);
            manifest.push(serde_json::json!({
                "path": path,
                "hash": hash,
                "size": content.len(),
            }));
            upload_files.insert(
                (*path).to_string(),
                serde_json::json!({ "content": B64.encode(content), "hash": hash }),
            );
        }
        let check = serde_json::json!({
            "slug": slug,
            "upload_id": upload_id,
            "expected_generation": expected_generation,
            "create": create,
            "files": manifest,
        });
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/pages/check-files")
                    .header("Authorization", format!("Bearer {token}"))
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(check.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        (upload_id, upload_files)
    }

    async fn finish_test_upload(
        app: &axum::Router,
        token: &str,
        slug: &str,
        visibility: &str,
        upload_id: &str,
        files: serde_json::Map<String, serde_json::Value>,
    ) -> String {
        let expected_generation = test_page_generation(app, token, slug).await;
        let create = expected_generation.is_none();
        let upload = serde_json::json!({
            "slug": slug,
            "upload_id": upload_id,
            "expected_generation": expected_generation,
            "create": create,
            "title": slug,
            "visibility": visibility,
            "files": files,
            "finalize": true,
        });
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/pages/upload-files")
                    .header("Authorization", format!("Bearer {token}"))
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(upload.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let freeze = serde_json::json!({
            "upload_id": upload_id,
            "expected_generation": expected_generation,
            "create": create,
            "title": slug,
        });
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/pages/{slug}/versions"))
                    .header("Authorization", format!("Bearer {token}"))
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(freeze.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let version: serde_json::Value = serde_json::from_slice(&body).unwrap();
        version["version_id"].as_str().unwrap().to_string()
    }

    #[tokio::test]
    async fn freeze_metadata_preconditions_preserve_concurrent_access_and_title_changes() {
        for (new_visibility, new_title) in [("private", "guarded"), ("public", "Renamed elsewhere")]
        {
            let (app, alice, _, pool) = setup_app_with_pool().await;
            let slug = "guarded";
            let files = [("index.html", b"<h1>original</h1>".as_slice())];
            let (upload_id, upload_files) = begin_test_upload(&app, &alice, slug, &files).await;
            finish_test_upload(&app, &alice, slug, "public", &upload_id, upload_files).await;
            let generation = test_page_generation(&app, &alice, slug).await.unwrap();
            let files = [("index.html", b"<h1>updated</h1>".as_slice())];
            let (upload_id, upload_files) = begin_test_upload(&app, &alice, slug, &files).await;
            let upload = serde_json::json!({
                "slug": slug, "upload_id": upload_id, "expected_generation": generation,
                "visibility": "public", "title": slug, "files": upload_files, "finalize": true,
            });
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/api/pages/upload-files")
                        .header("Authorization", format!("Bearer {alice}"))
                        .header("content-type", "application/json")
                        .body(axum::body::Body::from(upload.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);

            // Another client changes metadata after the content upload has started.
            let changes = serde_json::json!({
                "expected_generation": generation, "visibility": new_visibility, "title": new_title,
            });
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("PATCH")
                        .uri("/api/pages/guarded")
                        .header("Authorization", format!("Bearer {alice}"))
                        .header("content-type", "application/json")
                        .body(axum::body::Body::from(changes.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);

            let mut freeze = serde_json::json!({
                "upload_id": upload_id, "expected_generation": generation, "title": slug,
                "expected_visibility": "public", "expected_title": slug,
            });
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/api/pages/guarded/versions")
                        .header("Authorization", format!("Bearer {alice}"))
                        .header("content-type", "application/json")
                        .body(axum::body::Body::from(freeze.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::CONFLICT);
            let current = PageRow::get(&pool, "101", slug).await.unwrap().unwrap();
            assert_eq!(current.visibility, new_visibility);
            assert_eq!(current.title, new_title);
            assert_eq!(
                PageVersionRow::count_for_page(&pool, "101", slug)
                    .await
                    .unwrap(),
                1
            );

            // A fresh observation permits a retry; an explicit new title may replace the current one.
            freeze["expected_visibility"] = serde_json::json!(new_visibility);
            freeze["expected_title"] = serde_json::Value::Null;
            freeze["title"] = serde_json::json!("Agent title");
            // The upload's access setting must also match the fresh observation.
            let mut upload = upload;
            upload["visibility"] = serde_json::json!(new_visibility);
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/api/pages/upload-files")
                        .header("Authorization", format!("Bearer {alice}"))
                        .header("content-type", "application/json")
                        .body(axum::body::Body::from(upload.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/api/pages/guarded/versions")
                        .header("Authorization", format!("Bearer {alice}"))
                        .header("content-type", "application/json")
                        .body(axum::body::Body::from(freeze.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let current = PageRow::get(&pool, "101", slug).await.unwrap().unwrap();
            assert_eq!(current.visibility, new_visibility);
            assert_eq!(current.title, "Agent title");
            assert_eq!(
                PageVersionRow::count_for_page(&pool, "101", slug)
                    .await
                    .unwrap(),
                2
            );
        }
    }

    #[tokio::test]
    async fn completed_freeze_replays_the_original_version() {
        let (app, alice, _) = setup_app().await;
        let files = [("index.html", b"<h1>retry</h1>".as_slice())];
        let (upload_id, upload_files) =
            begin_test_upload(&app, &alice, "freeze-retry", &files).await;
        let first_version = finish_test_upload(
            &app,
            &alice,
            "freeze-retry",
            "private",
            &upload_id,
            upload_files,
        )
        .await;
        let replay = serde_json::json!({
            "upload_id": upload_id,
            "expected_generation": null,
            "create": true,
            "title": "freeze-retry",
        });
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/pages/freeze-retry/versions")
                    .header("Authorization", format!("Bearer {alice}"))
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(replay.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let replayed: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            replayed["version_id"].as_str(),
            Some(first_version.as_str())
        );

        let versions = app
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/pages/freeze-retry/versions?expected_generation={}",
                        replayed["generation"].as_str().unwrap()
                    ))
                    .header("Authorization", format!("Bearer {alice}"))
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = to_bytes(versions.into_body(), usize::MAX).await.unwrap();
        let versions: Vec<serde_json::Value> = serde_json::from_slice(&body).unwrap();
        assert_eq!(versions.len(), 1);
    }

    async fn save_version_with_legacy_generation_intent(
        app: &axum::Router,
        token: &str,
        slug: &str,
        html: &[u8],
    ) -> (String, String) {
        let upload_id = uuid::Uuid::new_v4().simple().to_string();
        let generation_before_check = test_page_generation(app, token, slug).await;
        let hash = hex_sha256(html);
        let check = serde_json::json!({
            "slug": slug,
            "upload_id": upload_id,
            "files": [{ "path": "index.html", "hash": hash, "size": html.len() }],
        });
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/pages/check-files")
                    .header("Authorization", format!("Bearer {token}"))
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(check.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let checked: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(checked["upload_id"].as_str(), Some(upload_id.as_str()));
        assert_eq!(
            checked["expected_generation"].as_str(),
            generation_before_check.as_deref(),
        );
        assert_eq!(
            checked["create"].as_bool(),
            Some(generation_before_check.is_none())
        );

        // This is the pre-generation client wire shape: upload and freeze do
        // not echo the new fields returned by check-files.
        let upload = serde_json::json!({
            "slug": slug,
            "upload_id": upload_id,
            "title": slug,
            "visibility": "private",
            "files": {
                "index.html": { "content": B64.encode(html), "hash": hash }
            },
            "finalize": true,
        });
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/pages/upload-files")
                    .header("Authorization", format!("Bearer {token}"))
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(upload.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let freeze = serde_json::json!({
            "upload_id": upload_id,
            "title": slug,
            "note": "legacy client",
        });
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/pages/{slug}/versions"))
                    .header("Authorization", format!("Bearer {token}"))
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(freeze.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let frozen: serde_json::Value = serde_json::from_slice(&body).unwrap();
        (
            frozen["generation"].as_str().unwrap().to_string(),
            frozen["version_id"].as_str().unwrap().to_string(),
        )
    }

    async fn save_and_deploy(app: &axum::Router, token: &str, slug: &str, html: &str) -> String {
        save_and_deploy_with_visibility(app, token, slug, html, "public").await
    }

    async fn save_and_deploy_with_visibility(
        app: &axum::Router,
        token: &str,
        slug: &str,
        html: &str,
        visibility: &str,
    ) -> String {
        let hash = hex_sha256(html.as_bytes());
        let b64 = B64.encode(html.as_bytes());
        let upload_id = uuid::Uuid::new_v4().simple().to_string();
        let expected_generation = test_page_generation(app, token, slug).await;
        let create = expected_generation.is_none();
        let check = serde_json::json!({
            "slug": slug,
            "upload_id": upload_id,
            "expected_generation": expected_generation,
            "create": create,
            "files": [{ "path": "index.html", "hash": hash, "size": html.len() }]
        });
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/pages/check-files")
                    .header("Authorization", format!("Bearer {token}"))
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(check.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let upload = serde_json::json!({
            "slug": slug,
            "upload_id": upload_id,
            "expected_generation": expected_generation,
            "create": create,
            "title": slug,
            "visibility": visibility,
            "finalize": true,
            "files": { "index.html": { "content": b64, "hash": hash } }
        });
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/pages/upload-files")
                    .header("Authorization", format!("Bearer {token}"))
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(upload.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        let freeze = serde_json::json!({
            "upload_id": upload_id,
            "expected_generation": expected_generation,
            "create": create,
            "title": slug,
            "note": "test"
        });
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/pages/{slug}/versions"))
                    .header("Authorization", format!("Bearer {token}"))
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(freeze.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let version_id = v["version_id"].as_str().unwrap().to_string();
        let generation = v["generation"].as_str().unwrap();

        let deploy = serde_json::json!({
            "version_id": version_id,
            "expected_generation": generation,
        });
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/pages/{slug}/deploy"))
                    .header("Authorization", format!("Bearer {token}"))
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(deploy.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        version_id
    }

    #[tokio::test]
    async fn save_does_not_publish_until_deploy() {
        let (app, alice, _) = setup_app().await;
        let hash = hex_sha256(b"<html>draft</html>");
        let b64 = B64.encode(b"<html>draft</html>");
        let upload_id = uuid::Uuid::new_v4().simple().to_string();
        let check = serde_json::json!({
            "slug": "staged",
            "upload_id": upload_id,
            "expected_generation": null,
            "create": true,
            "files": [{
                "path": "index.html",
                "hash": hash,
                "size": b"<html>draft</html>".len()
            }]
        });
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/pages/check-files")
                    .header("Authorization", format!("Bearer {alice}"))
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(check.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let upload = serde_json::json!({
            "slug": "staged",
            "upload_id": upload_id,
            "expected_generation": null,
            "create": true,
            "title": "staged",
            "visibility": "public",
            "files": { "index.html": { "content": b64, "hash": hash } }
        });
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/pages/upload-files")
                    .header("Authorization", format!("Bearer {alice}"))
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(upload.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/p/alice/staged")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);

        let version_id = save_and_deploy(&app, &alice, "staged2", "<html>live</html>").await;
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/p/alice/staged2")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers().get(header::CACHE_CONTROL).unwrap(),
            "no-store"
        );

        let resp = app
            .oneshot(
                Request::builder()
                    .uri(format!("/p/alice/staged2/@v/{version_id}"))
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn republish_manifest_removes_files_not_present_in_the_new_version() {
        let (app, alice, _) = setup_app().await;
        let first_files = [
            ("index.html", b"<html>first</html>".as_slice()),
            ("removed.txt", b"must not survive".as_slice()),
        ];
        let (first_upload, first_map) =
            begin_test_upload(&app, &alice, "clean-republish", &first_files).await;
        let first_version = finish_test_upload(
            &app,
            &alice,
            "clean-republish",
            "public",
            &first_upload,
            first_map,
        )
        .await;
        assert_eq!(
            get_page(
                &app,
                &format!("/p/alice/clean-republish/@v/{first_version}/removed.txt"),
                None,
            )
            .await,
            StatusCode::OK
        );

        let second_files = [("index.html", b"<html>second</html>".as_slice())];
        let (second_upload, second_map) =
            begin_test_upload(&app, &alice, "clean-republish", &second_files).await;
        let second_version = finish_test_upload(
            &app,
            &alice,
            "clean-republish",
            "public",
            &second_upload,
            second_map,
        )
        .await;
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/p/alice/clean-republish/@v/{second_version}/removed.txt"
                    ))
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        // Static Page routing falls back to the new index.html for unknown
        // paths. The old file content must not survive in the new manifest.
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(String::from_utf8_lossy(&body), "<html>second</html>");
    }

    #[tokio::test]
    async fn superseded_upload_session_cannot_mix_or_freeze_files() {
        let (app, alice, _) = setup_app().await;
        let first_files = [("index.html", b"<html>first</html>".as_slice())];
        let second_files = [("index.html", b"<html>second</html>".as_slice())];
        let (first_upload, first_map) =
            begin_test_upload(&app, &alice, "concurrent", &first_files).await;
        let (second_upload, second_map) =
            begin_test_upload(&app, &alice, "concurrent", &second_files).await;

        let stale_upload = serde_json::json!({
            "slug": "concurrent",
            "upload_id": first_upload,
            "visibility": "private",
            "files": first_map,
            "finalize": true,
        });
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/pages/upload-files")
                    .header("Authorization", format!("Bearer {alice}"))
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(stale_upload.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);

        let _ = finish_test_upload(
            &app,
            &alice,
            "concurrent",
            "private",
            &second_upload,
            second_map,
        )
        .await;
        let stale_freeze = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/pages/concurrent/versions")
                    .header("Authorization", format!("Bearer {alice}"))
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(
                        serde_json::json!({ "upload_id": first_upload }).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(stale_freeze.status(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn legacy_upload_requests_without_upload_id_remain_compatible() {
        let (app, alice, _) = setup_app().await;
        let html = b"<html>legacy</html>";
        let hash = hex_sha256(html);
        let check = serde_json::json!({
            "slug": "legacy-client",
            "expected_generation": null,
            "create": true,
            "files": [{ "path": "index.html", "hash": hash, "size": html.len() }]
        });
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/pages/check-files")
                    .header("Authorization", format!("Bearer {alice}"))
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(check.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let check_response: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(check_response.get("upload_id").is_none());

        let upload = serde_json::json!({
            "slug": "legacy-client",
            "expected_generation": null,
            "create": true,
            "title": "Legacy client",
            "visibility": "private",
            "files": {
                "index.html": { "content": B64.encode(html), "hash": hash }
            },
            "finalize": true
        });
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/pages/upload-files")
                    .header("Authorization", format!("Bearer {alice}"))
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(upload.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/pages/legacy-client/versions")
                    .header("Authorization", format!("Bearer {alice}"))
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(
                        serde_json::json!({
                            "expected_generation": null,
                            "create": true,
                            "title": "Legacy client",
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn pre_generation_upload_client_is_bound_to_new_and_existing_page_generations() {
        let (app, alice, _) = setup_app().await;
        let (created_generation, first_version) = save_version_with_legacy_generation_intent(
            &app,
            &alice,
            "rolling-upgrade",
            b"<html>first</html>",
        )
        .await;
        let (updated_generation, second_version) = save_version_with_legacy_generation_intent(
            &app,
            &alice,
            "rolling-upgrade",
            b"<html>second</html>",
        )
        .await;

        assert_eq!(updated_generation, created_generation);
        assert_ne!(second_version, first_version);
        let response = app
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/pages/rolling-upgrade/versions?expected_generation={created_generation}"
                    ))
                    .header("Authorization", format!("Bearer {alice}"))
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let versions: Vec<serde_json::Value> = serde_json::from_slice(&body).unwrap();
        assert_eq!(versions.len(), 2);
        assert!(versions
            .iter()
            .all(|version| version["generation"] == created_generation));
    }

    #[tokio::test]
    async fn pre_generation_management_client_binds_each_request_to_the_current_page() {
        let (app, alice, _) = setup_app().await;
        let (generation, first_version) = save_version_with_legacy_generation_intent(
            &app,
            &alice,
            "legacy-management",
            b"<html>first</html>",
        )
        .await;
        let (same_generation, second_version) = save_version_with_legacy_generation_intent(
            &app,
            &alice,
            "legacy-management",
            b"<html>second</html>",
        )
        .await;
        assert_eq!(same_generation, generation);

        let deployed = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/pages/legacy-management/deploy")
                    .header("Authorization", format!("Bearer {alice}"))
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(
                        serde_json::json!({
                            "version_id": first_version,
                            "expected_generation": "",
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(deployed.status(), StatusCode::OK);

        let open_ticket = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/pages/legacy-management")
                    .header("Authorization", format!("Bearer {alice}"))
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(open_ticket.status(), StatusCode::OK);

        let listed = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/pages/legacy-management/versions?expected_generation=")
                    .header("Authorization", format!("Bearer {alice}"))
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(listed.status(), StatusCode::OK);
        let listed_body = to_bytes(listed.into_body(), usize::MAX).await.unwrap();
        let listed_versions: Vec<serde_json::Value> = serde_json::from_slice(&listed_body).unwrap();
        assert_eq!(listed_versions.len(), 2);
        assert!(listed_versions
            .iter()
            .all(|version| version["generation"] == generation));

        let updated = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/api/pages/legacy-management")
                    .header("Authorization", format!("Bearer {alice}"))
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(
                        serde_json::json!({ "title": "Updated by legacy client" }).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(updated.status(), StatusCode::OK);
        let updated_body = to_bytes(updated.into_body(), usize::MAX).await.unwrap();
        let updated_page: serde_json::Value = serde_json::from_slice(&updated_body).unwrap();
        assert_eq!(updated_page["generation"], generation);
        assert_eq!(updated_page["title"], "Updated by legacy client");

        let unpublished = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/pages/legacy-management/unpublish")
                    .header("Authorization", format!("Bearer {alice}"))
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unpublished.status(), StatusCode::NO_CONTENT);

        let redeployed = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/pages/legacy-management/deploy")
                    .header("Authorization", format!("Bearer {alice}"))
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(
                        serde_json::json!({ "version_id": second_version }).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(redeployed.status(), StatusCode::OK);

        let deleted_version = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!(
                        "/api/pages/legacy-management/versions/{first_version}"
                    ))
                    .header("Authorization", format!("Bearer {alice}"))
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(deleted_version.status(), StatusCode::OK);

        let deleted_page = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/api/pages/legacy-management")
                    .header("Authorization", format!("Bearer {alice}"))
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(deleted_page.status(), StatusCode::OK);
        assert!(test_page_generation(&app, &alice, "legacy-management")
            .await
            .is_none());
    }

    #[tokio::test]
    async fn expired_session_pruning_waits_for_the_target_page_lock() {
        let manager = Arc::new(PageUploadManager::new());
        let key = page_upload_session_key("101", "locked");
        manager.sessions.insert(
            key.clone(),
            PageUploadSession {
                user_id: "101".to_string(),
                upload_id: Some("a".repeat(32)),
                draft_key: "pages/u1/locked/draft/id".to_string(),
                manifest: HashMap::new(),
                finalized: false,
                title: None,
                visibility: None,
                expected_generation: None,
                create: true,
                expires_at: Instant::now() - Duration::from_secs(1),
            },
        );
        let page_guard = manager.lock_for(&key).lock().await;
        let pruning_manager = Arc::clone(&manager);
        let mut pruning =
            tokio::spawn(async move { pruning_manager.prune_expired(Instant::now()).await });
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut pruning)
                .await
                .is_err()
        );
        manager.sessions.get_mut(&key).unwrap().expires_at =
            Instant::now() + PAGE_UPLOAD_SESSION_TTL;
        drop(page_guard);
        assert!(pruning.await.unwrap().is_empty());
        assert!(manager.sessions.contains_key(&key));
    }

    #[tokio::test]
    async fn upload_sessions_are_bounded_per_account_without_starving_others() {
        let (app, alice, bob) = setup_app().await;
        let hash = hex_sha256(b"x");
        for index in 0..MAX_PAGE_UPLOAD_SESSIONS_PER_USER {
            let check = serde_json::json!({
                "slug": format!("site-{index}"),
                "upload_id": format!("{index:032x}"),
                "expected_generation": null,
                "create": true,
                "files": [{ "path": "index.html", "hash": hash, "size": 1 }]
            });
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/api/pages/check-files")
                        .header("Authorization", format!("Bearer {alice}"))
                        .header("content-type", "application/json")
                        .body(axum::body::Body::from(check.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
        }
        let overflow = serde_json::json!({
            "slug": "site-overflow",
            "upload_id": "f".repeat(32),
            "expected_generation": null,
            "create": true,
            "files": [{ "path": "index.html", "hash": hash, "size": 1 }]
        });
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/pages/check-files")
                    .header("Authorization", format!("Bearer {alice}"))
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(overflow.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);

        let other_user = serde_json::json!({
            "slug": "other-user-site",
            "upload_id": "e".repeat(32),
            "expected_generation": null,
            "create": true,
            "files": [{ "path": "index.html", "hash": hash, "size": 1 }]
        });
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/pages/check-files")
                    .header("Authorization", format!("Bearer {bob}"))
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(other_user.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn page_metadata_and_max_file_upload_bounds_match_the_http_contract() {
        assert!(is_valid_page_title("A valid title"));
        assert!(!is_valid_page_title("bad\ntitle"));
        assert!(!is_valid_page_title(&"x".repeat(MAX_PAGE_TITLE_CHARS + 1)));
        assert!(is_valid_page_note(""));
        assert!(!is_valid_page_note("bad\tnote"));
        assert!(!is_valid_page_note(&"x".repeat(MAX_PAGE_NOTE_BYTES + 1)));

        let bytes = vec![0_u8; MAX_FILE_BYTES as usize];
        let encoded = B64.encode(&bytes);
        let payload = serde_json::json!({
            "slug": "max-file",
            "upload_id": "a".repeat(32),
            "title": "Max file",
            "visibility": "private",
            "files": {
                "index.html": { "content": encoded, "hash": hex_sha256(&bytes) }
            },
            "finalize": true
        })
        .to_string();
        assert!(payload.len() <= PAGE_UPLOAD_BODY_LIMIT);

        let (app, alice, _) = setup_app().await;
        let files = [("index.html", bytes.as_slice())];
        let (upload_id, files) = begin_test_upload(&app, &alice, "max-file", &files).await;
        let upload = serde_json::json!({
            "slug": "max-file",
            "upload_id": upload_id,
            "expected_generation": null,
            "create": true,
            "title": "Max file",
            "visibility": "private",
            "files": files,
            "finalize": true
        });
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/pages/upload-files")
                    .header("Authorization", format!("Bearer {alice}"))
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(upload.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn page_metadata_bounds_are_enforced_by_upload_freeze_and_update_routes() {
        let (app, alice, _) = setup_app().await;
        let files = [("index.html", b"<html>bounded</html>".as_slice())];
        let (upload_id, upload_files) =
            begin_test_upload(&app, &alice, "bounded-meta", &files).await;
        let invalid_upload = serde_json::json!({
            "slug": "bounded-meta",
            "upload_id": upload_id,
            "expected_generation": null,
            "create": true,
            "title": "bad\ntitle",
            "visibility": "private",
            "files": upload_files,
            "finalize": true
        });
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/pages/upload-files")
                    .header("Authorization", format!("Bearer {alice}"))
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(invalid_upload.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);

        let (upload_id, upload_files) =
            begin_test_upload(&app, &alice, "bounded-meta", &files).await;
        let valid_upload = serde_json::json!({
            "slug": "bounded-meta",
            "upload_id": upload_id,
            "expected_generation": null,
            "create": true,
            "title": "Bounded",
            "visibility": "private",
            "files": upload_files,
            "finalize": true
        });
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/pages/upload-files")
                    .header("Authorization", format!("Bearer {alice}"))
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(valid_upload.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/pages/bounded-meta/versions")
                    .header("Authorization", format!("Bearer {alice}"))
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(
                        serde_json::json!({
                            "upload_id": upload_id,
                            "expected_generation": null,
                            "create": true,
                            "note": "bad\tnote",
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/pages/bounded-meta/versions")
                    .header("Authorization", format!("Bearer {alice}"))
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(
                        serde_json::json!({
                            "upload_id": upload_id,
                            "expected_generation": null,
                            "create": true,
                            "note": "valid",
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let frozen: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let generation = frozen["generation"].as_str().unwrap();
        let response = app
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/api/pages/bounded-meta")
                    .header("Authorization", format!("Bearer {alice}"))
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(
                        serde_json::json!({
                            "expected_generation": generation,
                            "title": "x".repeat(MAX_PAGE_TITLE_CHARS + 1),
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn worker_can_use_kv() {
        let (app, alice, _) = setup_app().await;
        let worker = r#"
            function fetch(request, env) {
              if (request.path === "/api/hello") {
                env.KV.put("msg", "hi");
                return { status: 200, headers: { "content-type": "text/plain" }, body: env.KV.get("msg") };
              }
              return env.ASSETS.fetch("index.html");
            }
        "#;
        let files = [
            ("index.html", b"<html>static</html>".as_slice()),
            ("server/worker.js", worker.as_bytes()),
        ];
        let (upload_id, map) = begin_test_upload(&app, &alice, "fn", &files).await;
        let upload = serde_json::json!({
            "slug": "fn",
            "upload_id": upload_id,
            "expected_generation": null,
            "create": true,
            "title": "fn",
            "visibility": "public",
            "files": map,
            "finalize": true
        });
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/pages/upload-files")
                    .header("Authorization", format!("Bearer {alice}"))
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(upload.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let freeze = serde_json::json!({
            "upload_id": upload_id,
            "expected_generation": null,
            "create": true,
        });
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/pages/fn/versions")
                    .header("Authorization", format!("Bearer {alice}"))
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(freeze.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let version_id = v["version_id"].as_str().unwrap();
        let generation = v["generation"].as_str().unwrap();
        assert_eq!(v["has_worker"], true);

        let deploy = serde_json::json!({
            "version_id": version_id,
            "expected_generation": generation,
        });
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/pages/fn/deploy")
                    .header("Authorization", format!("Bearer {alice}"))
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(deploy.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/p/alice/fn/api/hello".to_string())
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        assert_eq!(String::from_utf8_lossy(&body), "hi");
    }

    #[tokio::test]
    async fn deployed_page_request_does_not_wait_for_running_worker_read_lease() {
        let (app, alice, _, pool) = setup_app_with_pool().await;
        let worker = r#"
            function fetch(request, env) {
              if (request.path === "/hold") {
                env.KV.put("hold-started", "yes");
                const until = Date.now() + 1200;
                while (Date.now() < until) {}
                return { status: 200, headers: { "content-type": "text/plain" }, body: "held" };
              }
              return { status: 200, headers: { "content-type": "text/plain" }, body: "fast" };
            }
        "#;
        let files = [("server/worker.js", worker.as_bytes())];
        let (upload_id, map) = begin_test_upload(&app, &alice, "shared-read", &files).await;
        let version =
            finish_test_upload(&app, &alice, "shared-read", "public", &upload_id, map).await;
        let generation = test_page_generation(&app, &alice, "shared-read")
            .await
            .unwrap();
        let deploy = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/pages/shared-read/deploy")
                    .header("Authorization", format!("Bearer {alice}"))
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(
                        serde_json::json!({
                            "version_id": version,
                            "expected_generation": generation,
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(deploy.status(), StatusCode::OK);

        let holding_request = tokio::spawn({
            let app = app.clone();
            async move {
                app.oneshot(
                    Request::builder()
                        .uri("/p/alice/shared-read/hold")
                        .body(axum::body::Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap()
            }
        });
        let mut observed_start = false;
        for _ in 0..200 {
            if page_kv::get(&pool, "101", "shared-read", "hold-started")
                .await
                .unwrap()
                .as_deref()
                == Some("yes")
            {
                observed_start = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(observed_start, "holding worker did not start");

        let fast_response = tokio::time::timeout(
            Duration::from_millis(400),
            app.clone().oneshot(
                Request::builder()
                    .uri("/p/alice/shared-read/fast")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            ),
        )
        .await
        .expect("deployed Page request waited for an existing read lease")
        .unwrap();
        assert_eq!(fast_response.status(), StatusCode::OK);
        let body = to_bytes(fast_response.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(body.as_ref(), b"fast");
        assert_eq!(holding_request.await.unwrap().status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn page_delete_waits_for_running_worker_and_leaves_no_orphan_kv() {
        let (app, alice, _, pool) = setup_app_with_pool().await;
        let worker = r#"
            function fetch(request, env) {
              env.KV.put("started", "yes");
              const until = Date.now() + 150;
              while (Date.now() < until) {}
              env.KV.put("late", "yes");
              return { status: 200, headers: { "content-type": "text/plain" }, body: "done" };
            }
        "#;
        let files = [("server/worker.js", worker.as_bytes())];
        let (upload_id, map) = begin_test_upload(&app, &alice, "delete-running", &files).await;
        let version =
            finish_test_upload(&app, &alice, "delete-running", "public", &upload_id, map).await;
        let generation = test_page_generation(&app, &alice, "delete-running")
            .await
            .unwrap();
        let deploy = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/pages/delete-running/deploy")
                    .header("Authorization", format!("Bearer {alice}"))
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(
                        serde_json::json!({
                            "version_id": version,
                            "expected_generation": generation,
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(deploy.status(), StatusCode::OK);

        let worker_app = app.clone();
        let worker_request = tokio::spawn(async move {
            worker_app
                .oneshot(
                    Request::builder()
                        .uri("/p/alice/delete-running/run")
                        .body(axum::body::Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap()
        });
        let mut observed_start = false;
        for _ in 0..200 {
            if page_kv::get(&pool, "101", "delete-running", "started")
                .await
                .unwrap()
                .as_deref()
                == Some("yes")
            {
                observed_start = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(observed_start, "worker did not start before delete");

        let mut deletion = tokio::spawn({
            let app = app.clone();
            let alice = alice.clone();
            let generation = generation.clone();
            async move {
                app.oneshot(
                    Request::builder()
                        .method("DELETE")
                        .uri(format!(
                            "/api/pages/delete-running?expected_generation={generation}"
                        ))
                        .header("Authorization", format!("Bearer {alice}"))
                        .body(axum::body::Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap()
            }
        });
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut deletion)
                .await
                .is_err()
        );
        assert_eq!(worker_request.await.unwrap().status(), StatusCode::OK);
        assert_eq!(deletion.await.unwrap().status(), StatusCode::OK);
        assert!(PageRow::get(&pool, "101", "delete-running")
            .await
            .unwrap()
            .is_none());
        assert!(page_kv::get(&pool, "101", "delete-running", "late")
            .await
            .unwrap()
            .is_none());
    }

    async fn get_page(app: &axum::Router, uri: &str, token: Option<&str>) -> StatusCode {
        let mut builder = Request::builder().uri(uri);
        if let Some(token) = token {
            builder = builder.header("Authorization", format!("Bearer {token}"));
        }
        let resp = app
            .clone()
            .oneshot(builder.body(axum::body::Body::empty()).unwrap())
            .await
            .unwrap();
        resp.status()
    }

    async fn login_page_cookie(
        app: &axum::Router,
        username: &str,
        slug: &str,
        version_id: Option<&str>,
    ) -> (String, String) {
        let return_to = match version_id {
            Some(version_id) => format!("/p/alice/{slug}/@v/{version_id}"),
            None => format!("/p/alice/{slug}"),
        };
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/page-auth/login")
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(
                        serde_json::json!({
                            "access_token": username,
                            "return_to": return_to,
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let set_cookie = response
            .headers()
            .get(header::SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();
        let cookie = set_cookie.split(';').next().unwrap().to_string();
        (cookie, set_cookie)
    }

    #[tokio::test]
    async fn visibility_matrix_private_relay_public() {
        let (app, alice, bob) = setup_app().await;
        save_and_deploy_with_visibility(&app, &alice, "priv", "<html>p</html>", "private").await;
        save_and_deploy_with_visibility(&app, &alice, "rel", "<html>r</html>", "relay").await;
        save_and_deploy(&app, &alice, "pub", "<html>u</html>").await;

        // Private: anonymous visitors are prompted to sign in, foreign
        // authenticated users cannot discover it, and the owner can view it.
        let anonymous_private = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/p/alice/priv")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(anonymous_private.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            anonymous_private
                .headers()
                .get(header::CONTENT_TYPE)
                .unwrap(),
            "text/html; charset=utf-8"
        );
        assert!(anonymous_private
            .headers()
            .get(header::CONTENT_SECURITY_POLICY)
            .is_some());
        let body = to_bytes(anonymous_private.into_body(), usize::MAX)
            .await
            .unwrap();
        let login_html = String::from_utf8_lossy(&body);
        assert!(login_html.contains("登录后访问"));
        assert!(login_html.contains("GitHub"));
        assert_eq!(
            get_page(&app, "/p/alice/priv", Some(&bob)).await,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            get_page(&app, "/p/alice/priv", Some(&alice)).await,
            StatusCode::OK
        );
        // Query-string tokens must be ignored (same-origin JS could steal them).
        assert_eq!(
            get_page(&app, &format!("/p/alice/priv?access_token={alice}"), None).await,
            StatusCode::UNAUTHORIZED
        );

        // Relay: any authenticated relay user may view, anonymous may not.
        assert_eq!(
            get_page(&app, "/p/alice/rel", None).await,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            get_page(&app, "/p/alice/rel", Some(&bob)).await,
            StatusCode::OK
        );
        assert_eq!(
            get_page(&app, "/p/alice/rel", Some(&alice)).await,
            StatusCode::OK
        );

        // Public: no credentials needed.
        assert_eq!(get_page(&app, "/p/alice/pub", None).await, StatusCode::OK);

        let generation = test_page_generation(&app, &alice, "pub").await.unwrap();
        let public_open = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/pages/pub")
                    .header("Authorization", format!("Bearer {alice}"))
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(
                        serde_json::json!({ "expected_generation": generation }).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(public_open.status(), StatusCode::OK);
        let body = to_bytes(public_open.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["open_url_path"], "/p/alice/pub");
        assert_eq!(json["page_url_path"], "/p/alice/pub");
        assert_eq!(json["expires_in_seconds"], 0);
    }

    #[tokio::test]
    async fn visibility_change_revokes_existing_browser_grants() {
        let (app, alice, _) = setup_app().await;
        save_and_deploy_with_visibility(
            &app,
            &alice,
            "visibility-revoke",
            "<html>private</html>",
            "private",
        )
        .await;
        let (cookie, _) = login_page_cookie(&app, "alice", "visibility-revoke", None).await;
        let authorized = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/p/alice/visibility-revoke")
                    .header(header::COOKIE, &cookie)
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(authorized.status(), StatusCode::OK);

        let generation = test_page_generation(&app, &alice, "visibility-revoke")
            .await
            .unwrap();
        let update = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/api/pages/visibility-revoke")
                    .header("Authorization", format!("Bearer {alice}"))
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(
                        serde_json::json!({
                            "expected_generation": generation,
                            "visibility": "relay",
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(update.status(), StatusCode::OK);

        let stale_grant = app
            .oneshot(
                Request::builder()
                    .uri("/p/alice/visibility-revoke")
                    .header(header::COOKIE, cookie)
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(stale_grant.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn browser_login_enforces_page_visibility_and_sets_scoped_http_only_cookie() {
        let (app, alice, _bob) = setup_app().await;
        let private_version = save_and_deploy_with_visibility(
            &app,
            &alice,
            "private-open",
            "<html>p</html>",
            "private",
        )
        .await;
        save_and_deploy_with_visibility(&app, &alice, "other-private", "<html>o</html>", "private")
            .await;
        save_and_deploy_with_visibility(&app, &alice, "relay-open", "<html>r</html>", "relay")
            .await;

        let open_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/pages/private-open")
                    .header("Authorization", format!("Bearer {alice}"))
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(
                        serde_json::json!({
                            "expected_generation": test_page_generation(
                                &app,
                                &alice,
                                "private-open",
                            )
                            .await
                            .unwrap(),
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(open_response.status(), StatusCode::OK);
        let body = to_bytes(open_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["open_url_path"], "/p/alice/private-open");
        assert_eq!(json["page_url_path"], "/p/alice/private-open");
        assert_eq!(json["expires_in_seconds"], 0);

        let login_page = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/p/alice/private-open")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(login_page.status(), StatusCode::UNAUTHORIZED);
        assert!(login_page.headers().get(header::SET_COOKIE).is_none());
        let body = to_bytes(login_page.into_body(), usize::MAX).await.unwrap();
        let html = String::from_utf8_lossy(&body);
        assert!(html.contains("GitHub"));
        assert!(html.contains("/api/page-auth/client.js"));

        let script = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/page-auth/client.js")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(script.status(), StatusCode::OK);
        assert_eq!(
            script.headers().get(header::CONTENT_TYPE).unwrap(),
            "application/javascript; charset=utf-8"
        );

        let wrong_password = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/page-auth/login")
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(
                        serde_json::json!({
                            "access_token": "invalid",
                            "return_to": "/p/alice/private-open",
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(wrong_password.status(), StatusCode::UNAUTHORIZED);
        assert!(wrong_password.headers().get(header::SET_COOKIE).is_none());

        let foreign_private = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/page-auth/login")
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(
                        serde_json::json!({
                            "access_token": "bob",
                            "return_to": "/p/alice/private-open",
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(foreign_private.status(), StatusCode::FORBIDDEN);
        assert!(foreign_private.headers().get(header::SET_COOKIE).is_none());

        let login = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/page-auth/login")
                    .header("x-forwarded-proto", "https")
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(
                        serde_json::json!({
                            "access_token": "alice",
                            "return_to": "/p/alice/private-open",
                            "path_prefix": "/relay",
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(login.status(), StatusCode::OK);
        let cookie = login
            .headers()
            .get(header::SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();
        assert!(cookie.contains("HttpOnly"));
        assert!(cookie.contains("SameSite=Lax"));
        assert!(cookie.contains("Secure"));
        assert!(cookie.contains("Path=/relay/p/alice/private-open"));
        assert!(!cookie.contains(&alice));
        let browser_cookie = cookie.split(';').next().unwrap();

        let authorized = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/p/alice/private-open")
                    .header(header::COOKIE, browser_cookie)
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(authorized.status(), StatusCode::OK);

        // A production browser session is not a blanket grant for immutable
        // preview routes, even when the preview belongs to the same Page.
        let wrong_version_scope = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/p/alice/private-open/@v/{private_version}"))
                    .header(header::COOKIE, browser_cookie)
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(wrong_version_scope.status(), StatusCode::UNAUTHORIZED);

        let wrong_page = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/p/alice/other-private")
                    .header(header::COOKIE, browser_cookie)
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(wrong_page.status(), StatusCode::UNAUTHORIZED);

        let relay_login = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/page-auth/login")
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(
                        serde_json::json!({
                            "access_token": "bob",
                            "return_to": "/p/alice/relay-open",
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(relay_login.status(), StatusCode::OK);
        let relay_cookie = relay_login
            .headers()
            .get(header::SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_string();
        let relay_page = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/p/alice/relay-open")
                    .header(header::COOKIE, relay_cookie)
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(relay_page.status(), StatusCode::OK);

        let open_redirect = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/page-auth/login")
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(
                        serde_json::json!({
                            "access_token": "alice",
                            "return_to": "https://attacker.invalid/",
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(open_redirect.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn isolated_page_login_uses_one_time_cross_origin_callback() {
        let config = crate::PageBrowserAuthConfig::new(
            "https://pages.test/site",
            "https://relay.test/relay",
        )
        .unwrap();
        let (app, alice, _, _) = setup_app_with_page_auth(Some(config)).await;
        save_and_deploy_with_visibility(
            &app,
            &alice,
            "isolated-login",
            "<html>private</html>",
            "private",
        )
        .await;

        let generation = test_page_generation(&app, &alice, "isolated-login")
            .await
            .unwrap();
        let open = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/pages/isolated-login")
                    .header("Authorization", format!("Bearer {alice}"))
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(
                        serde_json::json!({ "expected_generation": generation }).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(open.status(), StatusCode::OK);
        let body = to_bytes(open.into_body(), usize::MAX).await.unwrap();
        let open_json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            open_json["page_url_path"],
            "https://pages.test/site/p/alice/isolated-login"
        );

        let protected_page = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/p/alice/isolated-login")
                    .header(header::HOST, "pages.test")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(protected_page.status().is_redirection());
        assert!(protected_page.headers().get(header::SET_COOKIE).is_none());
        let sign_in_url = protected_page
            .headers()
            .get(header::LOCATION)
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();
        let state = sign_in_url
            .split_once("?state=")
            .map(|(_, state)| state)
            .unwrap();
        assert_eq!(state.len(), 64);
        assert!(sign_in_url.starts_with("https://relay.test/relay/api/page-auth/sign-in"));

        let page_on_auth_origin = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/p/alice/isolated-login")
                    .header(header::HOST, "relay.test")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(page_on_auth_origin.status(), StatusCode::NOT_FOUND);

        let wrong_host = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/page-auth/sign-in?state={state}"))
                    .header(header::HOST, "pages.test")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(wrong_host.status(), StatusCode::NOT_FOUND);

        let sign_in = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/page-auth/sign-in?state={state}"))
                    .header(header::HOST, "relay.test")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(sign_in.status(), StatusCode::OK);
        let body = to_bytes(sign_in.into_body(), usize::MAX).await.unwrap();
        let html = String::from_utf8_lossy(&body);
        assert!(html.contains("GitHub"));
        assert!(html.contains(&format!(r#"data-page-login-state="{state}""#)));
        assert!(html.contains(r#"src="./client.js""#));

        let login = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/page-auth/login")
                    .header(header::HOST, "relay.test")
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(
                        serde_json::json!({
                            "access_token": "alice",
                            "state": state,
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(login.status(), StatusCode::OK);
        assert!(login.headers().get(header::SET_COOKIE).is_none());
        let body = to_bytes(login.into_body(), usize::MAX).await.unwrap();
        let login_json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let callback_url = login_json["redirect_to"].as_str().unwrap();
        let code = callback_url
            .split_once("?code=")
            .map(|(_, code)| code)
            .unwrap();
        assert_eq!(code.len(), 64);
        assert!(callback_url.starts_with("https://pages.test/site/api/page-auth/callback"));

        let callback = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/page-auth/callback?code={code}"))
                    .header(header::HOST, "pages.test")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(callback.status().is_redirection());
        assert_eq!(
            callback.headers().get(header::LOCATION).unwrap(),
            "https://pages.test/site/p/alice/isolated-login"
        );
        let set_cookie = callback
            .headers()
            .get(header::SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(set_cookie.contains("Path=/site/p/alice/isolated-login;"));
        assert!(set_cookie.contains("HttpOnly"));
        assert!(set_cookie.contains("Secure"));
        let browser_cookie = set_cookie.split(';').next().unwrap();

        let replay = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/page-auth/callback?code={code}"))
                    .header(header::HOST, "pages.test")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(replay.status(), StatusCode::GONE);

        let page = app
            .oneshot(
                Request::builder()
                    .uri("/p/alice/isolated-login")
                    .header(header::HOST, "pages.test")
                    .header(header::COOKIE, browser_cookie)
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(page.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn production_and_preview_browser_grants_can_coexist() {
        let (app, alice, _) = setup_app().await;
        let version = save_and_deploy_with_visibility(
            &app,
            &alice,
            "cookie-scope",
            "<html>private</html>",
            "private",
        )
        .await;
        let (production_cookie, production_set_cookie) =
            login_page_cookie(&app, "alice", "cookie-scope", None).await;
        let (preview_cookie, preview_set_cookie) =
            login_page_cookie(&app, "alice", "cookie-scope", Some(&version)).await;
        assert!(production_set_cookie.contains("Path=/p/alice/cookie-scope;"));
        assert!(preview_set_cookie.contains(&format!("Path=/p/alice/cookie-scope/@v/{version};")));

        let combined = format!("{preview_cookie}; {production_cookie}");
        let production = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/p/alice/cookie-scope")
                    .header(header::COOKIE, &combined)
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(production.status(), StatusCode::OK);
        let preview = app
            .oneshot(
                Request::builder()
                    .uri(format!("/p/alice/cookie-scope/@v/{version}"))
                    .header(header::COOKIE, combined)
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(preview.status(), StatusCode::OK);
    }

    #[test]
    fn access_grants_are_generation_bound_and_capacity_is_per_user() {
        let manager = PageAccessManager::new();
        let grant = manager
            .issue_browser_grant(
                "101".into(),
                "viewer-1".into(),
                "site".into(),
                "generation-one".into(),
                None,
            )
            .unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_str(&format!("{PAGE_ACCESS_COOKIE}={grant}")).unwrap(),
        );
        assert!(manager.authorizes_page(&headers, "101", "site", "generation-one", None,));
        assert!(!manager.authorizes_page(&headers, "101", "site", "generation-two", None,));

        let bounded = PageAccessManager::new();
        for index in 0..MAX_PAGE_BROWSER_GRANTS_PER_USER {
            bounded
                .issue_browser_grant(
                    "101".into(),
                    "viewer-1".into(),
                    format!("site-{index}"),
                    "generation".into(),
                    None,
                )
                .unwrap();
        }
        assert_eq!(
            bounded
                .issue_browser_grant(
                    "101".into(),
                    "viewer-1".into(),
                    "overflow".into(),
                    "generation".into(),
                    None,
                )
                .unwrap_err(),
            StatusCode::TOO_MANY_REQUESTS
        );
        assert!(bounded
            .issue_browser_grant(
                "101".into(),
                "viewer-2".into(),
                "other".into(),
                "generation".into(),
                None,
            )
            .is_ok());
    }

    #[tokio::test]
    async fn deleting_and_recreating_a_page_rejects_the_old_browser_grant() {
        let (app, alice, _) = setup_app().await;
        save_and_deploy_with_visibility(&app, &alice, "recreated", "<html>old</html>", "private")
            .await;
        let (old_cookie, _) = login_page_cookie(&app, "alice", "recreated", None).await;
        let old_generation = test_page_generation(&app, &alice, "recreated")
            .await
            .unwrap();
        let deleted = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!(
                        "/api/pages/recreated?expected_generation={old_generation}"
                    ))
                    .header("Authorization", format!("Bearer {alice}"))
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(deleted.status(), StatusCode::OK);
        save_and_deploy_with_visibility(&app, &alice, "recreated", "<html>new</html>", "private")
            .await;
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/p/alice/recreated")
                    .header(header::COOKIE, old_cookie)
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn recreated_page_rejects_all_stale_generation_management_requests() {
        let (app, alice, _) = setup_app().await;
        save_and_deploy_with_visibility(&app, &alice, "aba", "<html>old</html>", "private").await;
        let old_generation = test_page_generation(&app, &alice, "aba").await.unwrap();

        // Leave an upload request owned by A in flight. Deleting A must make
        // this request unusable even after a new Page B takes the same slug.
        let stale_files = [("index.html", b"<html>stale upload</html>".as_slice())];
        let (stale_upload_id, stale_upload_files) =
            begin_test_upload(&app, &alice, "aba", &stale_files).await;

        let deleted = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!(
                        "/api/pages/aba?expected_generation={old_generation}"
                    ))
                    .header("Authorization", format!("Bearer {alice}"))
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(deleted.status(), StatusCode::OK);

        let new_version =
            save_and_deploy_with_visibility(&app, &alice, "aba", "<html>new</html>", "private")
                .await;
        let new_generation = test_page_generation(&app, &alice, "aba").await.unwrap();
        assert_ne!(new_generation, old_generation);

        let stale_upload = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/pages/upload-files")
                    .header("Authorization", format!("Bearer {alice}"))
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(
                        serde_json::json!({
                            "slug": "aba",
                            "upload_id": stale_upload_id,
                            "title": "stale",
                            "visibility": "private",
                            "files": stale_upload_files,
                            "finalize": true,
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(stale_upload.status(), StatusCode::CONFLICT);

        let stale_update = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/api/pages/aba")
                    .header("Authorization", format!("Bearer {alice}"))
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(
                        serde_json::json!({
                            "expected_generation": old_generation,
                            "title": "stale overwrite",
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(stale_update.status(), StatusCode::CONFLICT);

        let stale_versions = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/pages/aba/versions?expected_generation={old_generation}"
                    ))
                    .header("Authorization", format!("Bearer {alice}"))
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(stale_versions.status(), StatusCode::CONFLICT);

        let stale_open = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/pages/aba")
                    .header("Authorization", format!("Bearer {alice}"))
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(
                        serde_json::json!({ "expected_generation": old_generation }).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(stale_open.status(), StatusCode::CONFLICT);

        let stale_deploy = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/pages/aba/deploy")
                    .header("Authorization", format!("Bearer {alice}"))
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(
                        serde_json::json!({
                            "version_id": new_version,
                            "expected_generation": old_generation,
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(stale_deploy.status(), StatusCode::CONFLICT);

        let stale_unpublish = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!(
                        "/api/pages/aba/unpublish?expected_generation={old_generation}"
                    ))
                    .header("Authorization", format!("Bearer {alice}"))
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(stale_unpublish.status(), StatusCode::CONFLICT);

        let stale_version_delete = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!(
                        "/api/pages/aba/versions/{new_version}?expected_generation={old_generation}"
                    ))
                    .header("Authorization", format!("Bearer {alice}"))
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(stale_version_delete.status(), StatusCode::CONFLICT);

        let stale_check = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/pages/check-files")
                    .header("Authorization", format!("Bearer {alice}"))
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(
                        serde_json::json!({
                            "slug": "aba",
                            "upload_id": uuid::Uuid::new_v4().simple().to_string(),
                            "expected_generation": old_generation,
                            "create": false,
                            "files": [{
                                "path": "index.html",
                                "hash": hex_sha256(b"stale"),
                                "size": 5,
                            }],
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(stale_check.status(), StatusCode::CONFLICT);

        let stale_delete = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!(
                        "/api/pages/aba?expected_generation={old_generation}"
                    ))
                    .header("Authorization", format!("Bearer {alice}"))
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(stale_delete.status(), StatusCode::CONFLICT);
        assert_eq!(
            test_page_generation(&app, &alice, "aba").await.as_deref(),
            Some(new_generation.as_str()),
        );
    }

    #[tokio::test]
    async fn unpublish_stops_production_without_deleting_versions() {
        let (app, alice, _) = setup_app().await;
        let version_id = save_and_deploy(&app, &alice, "pause-me", "<html>live</html>").await;
        let generation = test_page_generation(&app, &alice, "pause-me")
            .await
            .unwrap();

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!(
                        "/api/pages/pause-me/unpublish?expected_generation={generation}"
                    ))
                    .header("Authorization", format!("Bearer {alice}"))
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            get_page(&app, "/p/alice/pause-me", None).await,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            get_page(&app, &format!("/p/alice/pause-me/@v/{version_id}"), None,).await,
            StatusCode::OK
        );

        let versions = app
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/pages/pause-me/versions?expected_generation={generation}"
                    ))
                    .header("Authorization", format!("Bearer {alice}"))
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(versions.status(), StatusCode::OK);
        let body = to_bytes(versions.into_body(), usize::MAX).await.unwrap();
        let list: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(list.as_array().unwrap().len(), 1);
        assert_eq!(list[0]["deployed"], false);
    }

    #[tokio::test]
    async fn worker_does_not_receive_credential_headers() {
        let (app, alice, _) = setup_app().await;
        let worker = r#"
            function fetch(request, env) {
              const leaked = request.headers["authorization"] || request.headers["cookie"] || "none";
              return { status: 200, headers: { "content-type": "text/plain" }, body: leaked };
            }
        "#;
        let files = [("server/worker.js", worker.as_bytes())];
        let (upload_id, map) = begin_test_upload(&app, &alice, "hdr", &files).await;
        let upload = serde_json::json!({
            "slug": "hdr",
            "upload_id": upload_id,
            "expected_generation": null,
            "create": true,
            "title": "hdr",
            "visibility": "relay",
            "files": map,
            "finalize": true
        });
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/pages/upload-files")
                    .header("Authorization", format!("Bearer {alice}"))
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(upload.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/pages/hdr/versions")
                    .header("Authorization", format!("Bearer {alice}"))
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(
                        serde_json::json!({
                            "upload_id": upload_id,
                            "expected_generation": null,
                            "create": true,
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let version_id = v["version_id"].as_str().unwrap();
        let generation = v["generation"].as_str().unwrap();
        let deploy = serde_json::json!({
            "version_id": version_id,
            "expected_generation": generation,
        });
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/pages/hdr/deploy")
                    .header("Authorization", format!("Bearer {alice}"))
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(deploy.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        // Viewer presents a valid bearer token to pass the relay gate; the
        // worker must not see it.
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/p/alice/hdr/api/echo")
                    .header("Authorization", format!("Bearer {alice}"))
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        assert_eq!(String::from_utf8_lossy(&body), "none");
    }

    #[tokio::test]
    async fn freeze_records_real_stats() {
        let (app, alice, _) = setup_app().await;
        let html = "<html>real bytes</html>";
        save_and_deploy(&app, &alice, "stats", html).await;

        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/api/pages")
                    .header("Authorization", format!("Bearer {alice}"))
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let pages: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let page = &pages[0];
        assert_eq!(page["file_count"].as_i64().unwrap(), 1);
        assert_eq!(page["total_bytes"].as_i64().unwrap(), html.len() as i64);
    }

    #[tokio::test]
    async fn page_request_body_limit_is_applied_before_worker_execution() {
        let (app, _, _) = setup_app().await;
        let body = vec![0u8; crate::page_execution::MAX_PAGE_FUNCTION_REQUEST_BODY_BYTES + 1];
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/p/alice/missing/api")
                    .body(axum::body::Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }
}
