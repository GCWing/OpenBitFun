use crate::artifacts::{ArtifactStore, MarketImageVariant};
use crate::auth::{
    AuthService, CompletedOAuth, DesktopAuthPollRequest, RefreshTokenRequest, RequestAuth,
    RequestAuthKind,
};
use crate::config::MarketConfig;
use crate::db::{AuthenticatedUser, Database};
use crate::error::{MarketError, MarketResult};
use crate::package::{
    validate_market_package, validate_min_openbitfun_version, validate_screenshot,
};
use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, Path, Query, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::{any, get, post, put};
use axum::{Json, Router};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chrono::Utc;
use openbitfun_product_domains::miniapp::market::{
    compute_review_bundle_hash, validate_market_category, validate_market_slug, CursorPage,
    MarketLicense, MarketListingDetail, MarketListingSummary, MarketRelease, MarketSort,
    MarketSubmission, MarketSubmissionDraftRequest, MarketSubmissionStatus, MarketUserSummary,
    ReviewDecision, ReviewDecisionRequest, MARKET_CATEGORIES, MARKET_DEFAULT_PAGE_SIZE,
    MARKET_MAX_PAGE_SIZE, MARKET_MAX_SCREENSHOTS, MARKET_PACKAGE_CONTENT_TYPE,
};
use openbitfun_product_domains::miniapp::types::{
    MiniAppI18n, MiniAppPermissions, NodePermissions,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use similar::TextDiff;
use sqlx::{QueryBuilder, Row, Sqlite};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use uuid::Uuid;

#[derive(Clone)]
pub(crate) struct MarketState {
    pub config: MarketConfig,
    pub db: Database,
    pub artifacts: ArtifactStore,
    pub auth: AuthService,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSubmissionMetadata {
    name: String,
    description: String,
    icon: String,
    category: String,
    tags: Vec<String>,
    #[serde(rename = "minOpenBitFunVersion")]
    min_openbitfun_version: String,
    changelog: String,
    license: MarketLicense,
    repository_url: Option<String>,
    permissions: MiniAppPermissions,
    i18n: Option<MiniAppI18n>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListingQuery {
    q: Option<String>,
    category: Option<String>,
    sort: Option<MarketSort>,
    cursor: Option<String>,
    limit: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImageVariantQuery {
    variant: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OAuthStartQuery {
    #[serde(alias = "return_to")]
    return_to: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OAuthCallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SubmissionListQuery {
    status: Option<MarketSubmissionStatus>,
}

#[derive(Debug, Deserialize)]
struct RatingRequest {
    value: u8,
}

#[derive(Debug, Deserialize)]
struct ModerationReason {
    reason: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MarketConfigResponse {
    github_auth_configured: bool,
    email_auth_configured: bool,
    public_browse: bool,
    web_submissions_enabled: bool,
    categories: &'static [&'static str],
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MeResponse {
    user: MarketUserSummary,
    #[serde(skip_serializing_if = "Option::is_none")]
    email: Option<String>,
    is_admin: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RatingAggregate {
    average: f64,
    count: u32,
    my_rating: Option<u8>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FavoriteAggregate {
    count: u32,
    is_favorited: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AdminSubmissionSummary {
    #[serde(flatten)]
    submission: MarketSubmission,
    submitter: MarketUserSummary,
    #[serde(skip_serializing_if = "Option::is_none")]
    submitted_at: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AdminSubmissionDetail {
    submission: MarketSubmission,
    submitter: MarketUserSummary,
    #[serde(skip_serializing_if = "Option::is_none")]
    submitted_at: Option<i64>,
    source_files: BTreeMap<String, String>,
    previous_source_files: BTreeMap<String, String>,
    source_diffs: BTreeMap<String, String>,
    screenshot_hashes: Vec<String>,
}

pub(crate) fn api_router(state: Arc<MarketState>) -> Router {
    let submission_policy_state = state.clone();
    Router::new()
        .route("/health", get(health))
        .route("/config", get(config))
        .route("/categories", get(categories))
        .route("/listings", get(list_listings))
        .route("/listings/{slug}", get(get_listing))
        .route(
            "/listings/{slug}/releases/{release_number}/download",
            get(download_release),
        )
        .route(
            "/listings/{slug}/rating",
            put(put_rating).delete(delete_rating),
        )
        .route(
            "/listings/{slug}/favorite",
            put(put_favorite).delete(delete_favorite),
        )
        .route("/screenshots/{sha256}", get(get_screenshot))
        .route("/auth/github/start", get(start_github_oauth))
        .route("/auth/github/callback", get(github_oauth_callback))
        .route("/auth/desktop/start", post(start_desktop_auth))
        .route("/auth/login/start", post(start_web_login))
        .route("/auth/login/github", post(login_github))
        .route("/auth/email/send", post(send_email_code))
        .route("/auth/email/verify", post(verify_email_code))
        .route("/auth/email/complete", get(complete_email_browser))
        .route("/auth/desktop/poll", post(poll_desktop_auth))
        .route("/auth/refresh", post(refresh_tokens))
        .route("/auth/logout", post(logout))
        .route("/me", get(me).post(verify_write_identity))
        .route(
            "/submissions",
            post(create_submission).get(list_my_submissions),
        )
        .route(
            "/submissions/{submission_id}",
            get(get_my_submission).delete(withdraw_submission),
        )
        .route(
            "/submissions/{submission_id}/package",
            put(upload_submission_package),
        )
        .route(
            "/submissions/{submission_id}/screenshots/{position}",
            put(upload_submission_screenshot).delete(delete_submission_screenshot),
        )
        .route(
            "/submissions/{submission_id}/submit",
            post(submit_submission),
        )
        .route("/admin/submissions", get(list_admin_submissions))
        .route(
            "/admin/submissions/{submission_id}",
            get(get_admin_submission),
        )
        .route(
            "/admin/submissions/{submission_id}/decision",
            post(review_submission),
        )
        .route("/admin/releases/{release_id}/yank", post(yank_release))
        .route(
            "/admin/listings/{listing_id}/unpublish",
            post(unpublish_listing),
        )
        // Unmatched API paths must return the versioned JSON error envelope.
        // A nested fallback would lose to the outer SPA catch-all, so this has
        // to be an explicit wildcard route that outranks `/miniapp/{*rest}`.
        .route("/{*rest}", any(api_not_found))
        .layer(DefaultBodyLimit::max(21 * 1024 * 1024))
        .layer(axum::middleware::from_fn_with_state(
            submission_policy_state,
            enforce_submission_write_policy,
        ))
        .layer(axum::middleware::from_fn(crate::auth_admission::admit))
        .with_state(state)
}

async fn api_not_found() -> MarketError {
    MarketError::not_found("Unknown API route.")
}

async fn enforce_submission_write_policy(
    State(state): State<Arc<MarketState>>,
    request: Request,
    next: Next,
) -> MarketResult<Response> {
    if is_submission_write_request(request.method(), request.uri().path()) {
        // Authenticate before Axum reads a JSON/package/screenshot body. This keeps the
        // disabled Web surface from becoming an unauthenticated upload sink.
        require_submission_write_auth(&state, request.headers()).await?;
    }
    Ok(next.run(request).await)
}

fn is_submission_write_request(method: &Method, path: &str) -> bool {
    let path = path
        .strip_prefix("/miniapp/api/v1")
        .unwrap_or(path)
        .trim_matches('/');
    let segments = path.split('/').collect::<Vec<_>>();
    matches!(
        (method.as_str(), segments.as_slice()),
        ("POST", ["submissions"])
            | ("DELETE", ["submissions", _])
            | ("PUT", ["submissions", _, "package"])
            | ("POST", ["submissions", _, "submit"])
            | ("PUT" | "DELETE", ["submissions", _, "screenshots", _])
    )
}

async fn health(State(state): State<Arc<MarketState>>) -> impl IntoResponse {
    let database_ready = sqlx::query_scalar::<_, i64>("SELECT 1")
        .fetch_one(state.db.pool())
        .await
        .is_ok();
    (
        if database_ready {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        },
        Json(serde_json::json!({
            "status": if database_ready { "ok" } else { "degraded" },
            "database": database_ready,
            "githubAuthConfigured": state.config.github_configured(),
            "emailAuthConfigured": state.auth.mailer.is_some(),
        })),
    )
}

async fn config(State(state): State<Arc<MarketState>>) -> Json<MarketConfigResponse> {
    Json(MarketConfigResponse {
        github_auth_configured: state.config.github_configured(),
        email_auth_configured: state.auth.mailer.is_some(),
        public_browse: state.config.public_browse,
        web_submissions_enabled: state.config.web_submissions_enabled,
        categories: MARKET_CATEGORIES,
    })
}

async fn categories() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "items": MARKET_CATEGORIES }))
}

async fn list_listings(
    State(state): State<Arc<MarketState>>,
    headers: HeaderMap,
    Query(query): Query<ListingQuery>,
) -> MarketResult<Json<CursorPage<MarketListingSummary>>> {
    let auth = state.auth.optional_auth(&headers).await?;
    ensure_public_browse(&state, auth.as_ref())?;
    let user_id = auth
        .as_ref()
        .map(|auth| auth.user.internal_id)
        .unwrap_or(-1);
    let limit = query
        .limit
        .unwrap_or(MARKET_DEFAULT_PAGE_SIZE)
        .clamp(1, MARKET_MAX_PAGE_SIZE);
    let offset = decode_cursor(query.cursor.as_deref())?;
    let sort = query.sort.unwrap_or_default();

    let mut builder = QueryBuilder::<Sqlite>::new(
        "SELECT l.id AS listing_id, l.slug, r.id AS release_id, r.release_number,
                r.metadata_json, r.package_sha256, r.package_size,
                r.review_bundle_hash, r.published_at,
                u.id AS owner_identity_id, u.github_id, COALESCE((SELECT email FROM email_identities WHERE user_id = u.id AND u.github_id IS NULL), u.login) AS login, u.avatar_url,
                COALESCE((SELECT AVG(value) FROM ratings WHERE listing_id = l.id), 0.0) AS rating_average,
                (SELECT COUNT(*) FROM ratings WHERE listing_id = l.id) AS rating_count,
                (SELECT COUNT(*) FROM favorites WHERE listing_id = l.id) AS favorite_count,
                (SELECT COUNT(*) FROM download_days WHERE listing_id = l.id) AS download_count,
                EXISTS(SELECT 1 FROM favorites WHERE listing_id = l.id AND user_id = ",
    );
    builder.push_bind(user_id);
    builder.push(
        ") AS is_favorited,
         (SELECT value FROM ratings WHERE listing_id = l.id AND user_id = ",
    );
    builder.push_bind(user_id);
    builder.push(
        ") AS my_rating
         FROM listings l
         JOIN releases r ON r.id = l.latest_release_id
         JOIN users u ON u.id = l.owner_user_id
         WHERE l.is_published = 1 AND r.yanked_at IS NULL",
    );
    if let Some(category) = query.category.filter(|value| !value.is_empty()) {
        if !validate_market_category(&category) {
            return Err(MarketError::bad_request(
                "invalid_category",
                "The requested category is not supported.",
            ));
        }
        builder.push(" AND json_extract(r.metadata_json, '$.category') = ");
        builder.push_bind(category);
    }
    if let Some(search) = query.q.filter(|value| !value.trim().is_empty()) {
        builder.push(
            " AND l.id IN (
                SELECT listing_id FROM listing_search WHERE listing_search MATCH ",
        );
        builder.push_bind(fts_query(&search));
        builder.push(")");
    }
    match sort {
        MarketSort::Newest => builder.push(" ORDER BY r.published_at DESC, l.id DESC"),
        MarketSort::Downloads => {
            builder.push(" ORDER BY download_count DESC, r.published_at DESC, l.id DESC")
        }
        MarketSort::Rating => {
            builder.push(" ORDER BY rating_average DESC, rating_count DESC, l.id DESC")
        }
    };
    builder.push(" LIMIT ");
    builder.push_bind(i64::from(limit + 1));
    builder.push(" OFFSET ");
    builder.push_bind(offset as i64);
    let rows = builder
        .build()
        .fetch_all(state.db.pool())
        .await
        .map_err(MarketError::internal)?;
    let has_more = rows.len() > limit as usize;
    let mut items = Vec::with_capacity(rows.len().min(limit as usize));
    for row in rows.into_iter().take(limit as usize) {
        items.push(summary_from_row(&state, row).await?);
    }
    Ok(Json(CursorPage {
        items,
        next_cursor: has_more.then(|| encode_cursor(offset + limit as u64)),
    }))
}

async fn get_listing(
    State(state): State<Arc<MarketState>>,
    headers: HeaderMap,
    Path(slug): Path<String>,
) -> MarketResult<Json<MarketListingDetail>> {
    let auth = state.auth.optional_auth(&headers).await?;
    ensure_public_browse(&state, auth.as_ref())?;
    let user_id = auth
        .as_ref()
        .map(|auth| auth.user.internal_id)
        .unwrap_or(-1);
    Ok(Json(listing_detail_by_slug(&state, &slug, user_id).await?))
}

async fn download_release(
    State(state): State<Arc<MarketState>>,
    headers: HeaderMap,
    Path((slug, release_number)): Path<(String, u32)>,
) -> MarketResult<Response> {
    let auth = state.auth.optional_auth(&headers).await?;
    ensure_public_browse(&state, auth.as_ref())?;
    let row = sqlx::query(
        "SELECT l.id AS listing_id, l.slug, r.package_sha256, r.package_size
         FROM listings l
         JOIN releases r ON r.listing_id = l.id
         WHERE l.slug = ? AND l.is_published = 1
           AND r.release_number = ? AND r.yanked_at IS NULL",
    )
    .bind(&slug)
    .bind(i64::from(release_number))
    .fetch_optional(state.db.pool())
    .await
    .map_err(MarketError::internal)?
    .ok_or_else(|| MarketError::not_found("The requested MiniApp release is unavailable."))?;
    let listing_id: String = row.get("listing_id");
    let package_sha256: String = row.get("package_sha256");
    let bytes = state.artifacts.read_package(&package_sha256).await?;
    record_download(&state, &headers, &listing_id).await?;

    let mut response = Response::new(Body::from(bytes));
    *response.status_mut() = StatusCode::OK;
    let response_headers = response.headers_mut();
    response_headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(MARKET_PACKAGE_CONTENT_TYPE),
    );
    response_headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!(
            "attachment; filename=\"{}-{}.bfminiapp\"",
            safe_filename(&slug),
            release_number
        ))
        .map_err(MarketError::internal)?,
    );
    response_headers.insert(
        HeaderNameExt::checksum(),
        HeaderValue::from_str(&package_sha256).map_err(MarketError::internal)?,
    );
    response_headers.insert(
        header::ETAG,
        HeaderValue::from_str(&format!("\"{package_sha256}\"")).map_err(MarketError::internal)?,
    );
    response_headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=31536000, immutable"),
    );
    Ok(response)
}

async fn get_screenshot(
    State(state): State<Arc<MarketState>>,
    Path(sha256): Path<String>,
    Query(query): Query<ImageVariantQuery>,
) -> MarketResult<Response> {
    if sha256.len() != 64 || !sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(MarketError::not_found("Marketplace image was not found."));
    }
    let variant = match query.variant.as_deref() {
        None => None,
        Some("compact-v1") => Some(MarketImageVariant::CompactV1),
        Some("large-v1") => Some(MarketImageVariant::LargeV1),
        Some(_) => {
            return Err(MarketError::bad_request(
                "invalid_image_variant",
                "Image variant must be compact-v1 or large-v1.",
            ))
        }
    };
    let bytes = match variant {
        Some(variant) => {
            state
                .artifacts
                .read_screenshot_variant(&sha256, variant)
                .await?
        }
        None => state.artifacts.read_screenshot(&sha256).await?,
    };
    let content_length = bytes.len();
    let etag = match variant {
        Some(variant) => format!("\"{}-{}\"", sha256, variant.cache_key()),
        None => format!("\"{sha256}\""),
    };
    let mut response = Response::new(Body::from(bytes));
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("image/webp"));
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=31536000, immutable"),
    );
    response.headers_mut().insert(
        header::ETAG,
        HeaderValue::from_str(&etag).map_err(MarketError::internal)?,
    );
    response.headers_mut().insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&content_length.to_string()).map_err(MarketError::internal)?,
    );
    Ok(response)
}

async fn start_github_oauth(
    State(state): State<Arc<MarketState>>,
    Query(query): Query<OAuthStartQuery>,
) -> MarketResult<Redirect> {
    let url = state
        .auth
        .start_web_oauth(query.return_to.as_deref().unwrap_or("/miniapp/"))
        .await?;
    Ok(Redirect::temporary(&url))
}

async fn github_oauth_callback(
    State(state): State<Arc<MarketState>>,
    Query(query): Query<OAuthCallbackQuery>,
) -> MarketResult<Response> {
    if let Some(error) = query.error {
        return Err(MarketError::bad_request(
            "github_oauth_denied",
            query.error_description.unwrap_or(error),
        ));
    }
    let code = query.code.ok_or_else(|| {
        MarketError::bad_request("missing_oauth_code", "GitHub did not return a code.")
    })?;
    let oauth_state = query.state.ok_or_else(|| {
        MarketError::bad_request("missing_oauth_state", "GitHub did not return state.")
    })?;
    complete_login_response(
        &state,
        state.auth.complete_oauth(&code, &oauth_state).await?,
        false,
    )
}

fn complete_login_response(
    state: &MarketState,
    completed: CompletedOAuth,
    json: bool,
) -> MarketResult<Response> {
    match completed {
        CompletedOAuth::Web {
            return_to,
            session_token,
            csrf_token,
            expires_at,
        } => {
            let mut response = if json {
                Json(serde_json::json!({"redirectUrl": return_to})).into_response()
            } else {
                Redirect::to(&return_to).into_response()
            };
            state.auth.append_web_session_cookies(
                response.headers_mut(),
                &session_token,
                &csrf_token,
                expires_at,
            )?;
            Ok(response)
        }
        CompletedOAuth::Desktop {
            session_token,
            csrf_token,
            expires_at,
        } => {
            let complete_url = format!("{}/complete", state.config.auth_base_url());
            let mut response = if json {
                Json(serde_json::json!({"redirectUrl": complete_url})).into_response()
            } else {
                Redirect::to(&complete_url).into_response()
            };
            state.auth.append_web_session_cookies(
                response.headers_mut(),
                &session_token,
                &csrf_token,
                expires_at,
            )?;
            Ok(response)
        }
    }
}

#[derive(Default, Deserialize)]
struct LoginMethods {
    methods: Option<String>,
}

async fn start_desktop_auth(
    State(state): State<Arc<MarketState>>,
    Query(query): Query<LoginMethods>,
) -> MarketResult<Json<crate::auth::DesktopAuthStart>> {
    Ok(Json(
        state
            .auth
            .start_desktop_login(query.methods.as_deref() == Some("all"))
            .await?,
    ))
}

async fn poll_desktop_auth(
    State(state): State<Arc<MarketState>>,
    Json(request): Json<DesktopAuthPollRequest>,
) -> MarketResult<Json<crate::auth::DesktopAuthPollResponse>> {
    Ok(Json(state.auth.poll_desktop(request).await?))
}

async fn refresh_tokens(
    State(state): State<Arc<MarketState>>,
    Json(request): Json<RefreshTokenRequest>,
) -> MarketResult<Json<crate::auth::MarketTokenPair>> {
    Ok(Json(
        state.auth.refresh_tokens(&request.refresh_token).await?,
    ))
}

async fn me(State(state): State<Arc<MarketState>>, headers: HeaderMap) -> MarketResult<Response> {
    let auth = state.auth.require_auth(&headers).await?;
    let mut response = identity_response(&state, &auth);
    state
        .auth
        .append_shared_account_cookies(response.headers_mut(), &headers, &auth)?;
    Ok(response)
}

async fn verify_write_identity(
    State(state): State<Arc<MarketState>>,
    headers: HeaderMap,
) -> MarketResult<Response> {
    let auth = state.auth.require_auth(&headers).await?;
    state.auth.require_csrf(&headers, &auth)?;
    Ok(identity_response(&state, &auth))
}

fn identity_response(state: &MarketState, auth: &RequestAuth) -> Response {
    let mut response = Json(MeResponse {
        is_admin: state.auth.is_admin(&auth.user),
        user: auth.user.profile.clone(),
        email: auth.user.email.clone(),
    })
    .into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn logout(
    State(state): State<Arc<MarketState>>,
    headers: HeaderMap,
) -> MarketResult<Response> {
    let auth = state.auth.require_auth(&headers).await?;
    state.auth.require_csrf(&headers, &auth)?;
    state.auth.logout(&auth).await?;
    let mut response = StatusCode::NO_CONTENT.into_response();
    state.auth.append_clear_cookies(response.headers_mut())?;
    Ok(response)
}

async fn create_submission(
    State(state): State<Arc<MarketState>>,
    headers: HeaderMap,
    Json(request): Json<MarketSubmissionDraftRequest>,
) -> MarketResult<Json<MarketSubmission>> {
    let auth = require_submission_write_auth(&state, &headers).await?;
    validate_submission_request(&request)?;
    let listing_id = validate_listing_ownership_and_release(
        &state,
        &auth.user,
        request.listing_id.as_deref(),
        &request.slug,
        request.release_number,
    )
    .await?;
    let now = Utc::now().timestamp();
    let submission_id = Uuid::new_v4().to_string();
    let metadata = StoredSubmissionMetadata {
        name: request.name.trim().to_string(),
        description: request.description.trim().to_string(),
        icon: request.icon.trim().to_string(),
        category: request.category.clone(),
        tags: request.tags.clone(),
        min_openbitfun_version: request.min_openbitfun_version.clone(),
        changelog: request.changelog.trim().to_string(),
        license: request.license.clone(),
        repository_url: request.repository_url.clone(),
        permissions: MiniAppPermissions {
            node: Some(NodePermissions {
                enabled: false,
                max_memory_mb: None,
                timeout_ms: None,
            }),
            ..MiniAppPermissions::default()
        },
        i18n: None,
    };
    sqlx::query(
        "INSERT INTO submissions(
            id, listing_id, owner_user_id, slug, release_number, metadata_json,
            status, created_at, updated_at
         ) VALUES(?, ?, ?, ?, ?, ?, 'draft', ?, ?)",
    )
    .bind(&submission_id)
    .bind(listing_id)
    .bind(auth.user.internal_id)
    .bind(&request.slug)
    .bind(i64::from(request.release_number))
    .bind(canonical_metadata_json(&metadata)?)
    .bind(now)
    .bind(now)
    .execute(state.db.pool())
    .await
    .map_err(map_unique_submission_error)?;
    Ok(Json(
        submission_by_id(&state, &submission_id, auth.user.internal_id, false).await?,
    ))
}

async fn upload_submission_package(
    State(state): State<Arc<MarketState>>,
    headers: HeaderMap,
    Path(submission_id): Path<String>,
    body: Bytes,
) -> MarketResult<Json<MarketSubmission>> {
    let auth = require_submission_write_auth(&state, &headers).await?;
    let submission = submission_by_id(&state, &submission_id, auth.user.internal_id, false).await?;
    if submission.status != MarketSubmissionStatus::Draft {
        return Err(MarketError::conflict(
            "submission_not_editable",
            "Only draft submissions may be edited.",
        ));
    }
    let package = validate_market_package(&body)?;
    state.artifacts.put_package(&package.sha256, &body).await?;
    let row = sqlx::query("SELECT metadata_json FROM submissions WHERE id = ?")
        .bind(&submission_id)
        .fetch_one(state.db.pool())
        .await
        .map_err(MarketError::internal)?;
    let mut metadata: StoredSubmissionMetadata =
        serde_json::from_str(row.get("metadata_json")).map_err(MarketError::internal)?;
    metadata.permissions = package.meta.permissions;
    metadata.i18n = package.meta.i18n;
    sqlx::query(
        "UPDATE submissions
         SET metadata_json = ?, package_sha256 = ?, package_size = ?, updated_at = ?
         WHERE id = ? AND status = 'draft'",
    )
    .bind(canonical_metadata_json(&metadata)?)
    .bind(&package.sha256)
    .bind(package.size as i64)
    .bind(Utc::now().timestamp())
    .bind(&submission_id)
    .execute(state.db.pool())
    .await
    .map_err(MarketError::internal)?;
    Ok(Json(
        submission_by_id(&state, &submission_id, auth.user.internal_id, false).await?,
    ))
}

async fn upload_submission_screenshot(
    State(state): State<Arc<MarketState>>,
    headers: HeaderMap,
    Path((submission_id, position)): Path<(String, u32)>,
    body: Bytes,
) -> MarketResult<Json<MarketSubmission>> {
    let auth = require_submission_write_auth(&state, &headers).await?;
    if position as usize >= MARKET_MAX_SCREENSHOTS {
        return Err(MarketError::bad_request(
            "invalid_screenshot_position",
            "Marketplace image positions range from 0 through 4.",
        ));
    }
    let submission = submission_by_id(&state, &submission_id, auth.user.internal_id, false).await?;
    if submission.status != MarketSubmissionStatus::Draft {
        return Err(MarketError::conflict(
            "submission_not_editable",
            "Only draft submissions may be edited.",
        ));
    }
    let screenshot = validate_screenshot(&body)?;
    state
        .artifacts
        .put_screenshot(&screenshot.sha256, &screenshot.bytes)
        .await?;
    sqlx::query(
        "INSERT INTO screenshots(
            id, submission_id, position, sha256, media_type, size_bytes, width, height, created_at
         ) VALUES(?, ?, ?, ?, 'image/webp', ?, ?, ?, ?)
         ON CONFLICT(submission_id, position) DO UPDATE SET
            id = excluded.id, sha256 = excluded.sha256, media_type = excluded.media_type,
            size_bytes = excluded.size_bytes, width = excluded.width, height = excluded.height,
            created_at = excluded.created_at",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(&submission_id)
    .bind(i64::from(position))
    .bind(&screenshot.sha256)
    .bind(screenshot.bytes.len() as i64)
    .bind(i64::from(screenshot.width))
    .bind(i64::from(screenshot.height))
    .bind(Utc::now().timestamp())
    .execute(state.db.pool())
    .await
    .map_err(MarketError::internal)?;
    Ok(Json(
        submission_by_id(&state, &submission_id, auth.user.internal_id, false).await?,
    ))
}

async fn delete_submission_screenshot(
    State(state): State<Arc<MarketState>>,
    headers: HeaderMap,
    Path((submission_id, position)): Path<(String, u32)>,
) -> MarketResult<StatusCode> {
    let auth = require_submission_write_auth(&state, &headers).await?;
    let submission = submission_by_id(&state, &submission_id, auth.user.internal_id, false).await?;
    if submission.status != MarketSubmissionStatus::Draft {
        return Err(MarketError::conflict(
            "submission_not_editable",
            "Only draft submissions may be edited.",
        ));
    }
    sqlx::query("DELETE FROM screenshots WHERE submission_id = ? AND position = ?")
        .bind(&submission_id)
        .bind(i64::from(position))
        .execute(state.db.pool())
        .await
        .map_err(MarketError::internal)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn submit_submission(
    State(state): State<Arc<MarketState>>,
    headers: HeaderMap,
    Path(submission_id): Path<String>,
) -> MarketResult<Json<MarketSubmission>> {
    let auth = require_submission_write_auth(&state, &headers).await?;
    let submission = submission_by_id(&state, &submission_id, auth.user.internal_id, false).await?;
    if submission.status != MarketSubmissionStatus::Draft {
        return Err(MarketError::conflict(
            "invalid_submission_transition",
            "Only draft submissions may be submitted.",
        ));
    }
    if submission.package_sha256.is_none() {
        return Err(MarketError::bad_request(
            "package_required",
            "Upload a validated .bfminiapp package before submitting.",
        ));
    }
    if submission.screenshot_urls.is_empty() {
        return Err(MarketError::bad_request(
            "screenshot_required",
            "At least one marketplace image is required.",
        ));
    }
    validate_listing_ownership_and_release(
        &state,
        &auth.user,
        submission.listing_id.as_deref(),
        &submission.slug,
        submission.release_number,
    )
    .await?;
    let now = Utc::now().timestamp();
    let updated = sqlx::query(
        "UPDATE submissions SET status = 'submitted', submitted_at = ?, updated_at = ?
         WHERE id = ? AND owner_user_id = ? AND status = 'draft'",
    )
    .bind(now)
    .bind(now)
    .bind(&submission_id)
    .bind(auth.user.internal_id)
    .execute(state.db.pool())
    .await
    .map_err(MarketError::internal)?;
    if updated.rows_affected() != 1 {
        return Err(MarketError::conflict(
            "invalid_submission_transition",
            "The submission changed while it was being submitted.",
        ));
    }
    Ok(Json(
        submission_by_id(&state, &submission_id, auth.user.internal_id, false).await?,
    ))
}

async fn withdraw_submission(
    State(state): State<Arc<MarketState>>,
    headers: HeaderMap,
    Path(submission_id): Path<String>,
) -> MarketResult<Json<MarketSubmission>> {
    let auth = require_submission_write_auth(&state, &headers).await?;
    let now = Utc::now().timestamp();
    let updated = sqlx::query(
        "UPDATE submissions SET status = 'withdrawn', updated_at = ?
         WHERE id = ? AND owner_user_id = ? AND status IN ('draft', 'submitted')",
    )
    .bind(now)
    .bind(&submission_id)
    .bind(auth.user.internal_id)
    .execute(state.db.pool())
    .await
    .map_err(MarketError::internal)?;
    if updated.rows_affected() != 1 {
        return Err(MarketError::conflict(
            "invalid_submission_transition",
            "Only draft or submitted entries may be withdrawn.",
        ));
    }
    Ok(Json(
        submission_by_id(&state, &submission_id, auth.user.internal_id, false).await?,
    ))
}

async fn list_my_submissions(
    State(state): State<Arc<MarketState>>,
    headers: HeaderMap,
    Query(query): Query<SubmissionListQuery>,
) -> MarketResult<Json<CursorPage<MarketSubmission>>> {
    let auth = state.auth.require_auth(&headers).await?;
    let items = list_submissions(&state, Some(auth.user.internal_id), query.status, false).await?;
    Ok(Json(CursorPage {
        items,
        next_cursor: None,
    }))
}

async fn get_my_submission(
    State(state): State<Arc<MarketState>>,
    headers: HeaderMap,
    Path(submission_id): Path<String>,
) -> MarketResult<Json<MarketSubmission>> {
    let auth = state.auth.require_auth(&headers).await?;
    Ok(Json(
        submission_by_id(&state, &submission_id, auth.user.internal_id, false).await?,
    ))
}

async fn list_admin_submissions(
    State(state): State<Arc<MarketState>>,
    headers: HeaderMap,
    Query(query): Query<SubmissionListQuery>,
) -> MarketResult<Json<CursorPage<AdminSubmissionSummary>>> {
    require_admin(&state, &headers).await?;
    let items = list_admin_submission_summaries(&state, query.status).await?;
    Ok(Json(CursorPage {
        items,
        next_cursor: None,
    }))
}

async fn get_admin_submission(
    State(state): State<Arc<MarketState>>,
    headers: HeaderMap,
    Path(submission_id): Path<String>,
) -> MarketResult<Json<AdminSubmissionDetail>> {
    require_admin(&state, &headers).await?;
    let AdminSubmissionSummary {
        submission,
        submitter,
        submitted_at,
    } = admin_submission_by_id(&state, &submission_id).await?;
    let source_files = if let Some(hash) = submission.package_sha256.as_deref() {
        let package = state.artifacts.read_package(hash).await?;
        validate_market_package(&package)?.source_files
    } else {
        BTreeMap::new()
    };
    let previous_source_files = if let Some(listing_id) = submission.listing_id.as_deref() {
        let previous_hash = sqlx::query_scalar::<_, String>(
            "SELECT package_sha256 FROM releases
             WHERE listing_id = ?
             ORDER BY release_number DESC LIMIT 1",
        )
        .bind(listing_id)
        .fetch_optional(state.db.pool())
        .await
        .map_err(MarketError::internal)?;
        if let Some(hash) = previous_hash {
            let package = state.artifacts.read_package(&hash).await?;
            validate_market_package(&package)?.source_files
        } else {
            BTreeMap::new()
        }
    } else {
        BTreeMap::new()
    };
    let source_diffs = build_source_diffs(&previous_source_files, &source_files);
    let screenshot_hashes = sqlx::query_scalar::<_, String>(
        "SELECT sha256 FROM screenshots
         WHERE submission_id = ? ORDER BY position",
    )
    .bind(&submission_id)
    .fetch_all(state.db.pool())
    .await
    .map_err(MarketError::internal)?;
    Ok(Json(AdminSubmissionDetail {
        submission,
        submitter,
        submitted_at,
        source_files,
        previous_source_files,
        source_diffs,
        screenshot_hashes,
    }))
}

fn build_source_diffs(
    previous: &BTreeMap<String, String>,
    current: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    let names = previous
        .keys()
        .chain(current.keys())
        .cloned()
        .collect::<BTreeSet<_>>();
    names
        .into_iter()
        .map(|name| {
            let before = previous.get(&name).map(String::as_str).unwrap_or("");
            let after = current.get(&name).map(String::as_str).unwrap_or("");
            let diff = TextDiff::from_lines(before, after)
                .unified_diff()
                .context_radius(4)
                .header(&format!("a/{name}"), &format!("b/{name}"))
                .to_string();
            (name, diff)
        })
        .collect()
}

async fn review_submission(
    State(state): State<Arc<MarketState>>,
    headers: HeaderMap,
    Path(submission_id): Path<String>,
    Json(request): Json<ReviewDecisionRequest>,
) -> MarketResult<Json<MarketSubmission>> {
    let admin = require_admin_write(&state, &headers).await?;
    match request.decision {
        ReviewDecision::Reject => {
            if request.reason.trim().is_empty() {
                return Err(MarketError::bad_request(
                    "rejection_reason_required",
                    "A rejection reason is required.",
                ));
            }
            let now = Utc::now().timestamp();
            let updated = sqlx::query(
                "UPDATE submissions
                 SET status = 'rejected', rejection_reason = ?, reviewer_user_id = ?,
                     reviewed_at = ?, updated_at = ?
                 WHERE id = ? AND status = 'submitted'",
            )
            .bind(request.reason.trim())
            .bind(admin.user.internal_id)
            .bind(now)
            .bind(now)
            .bind(&submission_id)
            .execute(state.db.pool())
            .await
            .map_err(MarketError::internal)?;
            if updated.rows_affected() != 1 {
                return Err(MarketError::conflict(
                    "submission_not_reviewable",
                    "Only submitted entries may be reviewed.",
                ));
            }
            insert_audit(
                &state,
                admin.user.internal_id,
                "submission_rejected",
                "submission",
                &submission_id,
                serde_json::json!({ "reason": request.reason.trim() }),
            )
            .await?;
        }
        ReviewDecision::Approve => {
            approve_submission(&state, &admin.user, &submission_id).await?;
        }
    }
    Ok(Json(
        submission_by_id(&state, &submission_id, admin.user.internal_id, true).await?,
    ))
}

async fn yank_release(
    State(state): State<Arc<MarketState>>,
    headers: HeaderMap,
    Path(release_id): Path<String>,
    Json(request): Json<ModerationReason>,
) -> MarketResult<StatusCode> {
    let admin = require_admin_write(&state, &headers).await?;
    if request.reason.trim().is_empty() {
        return Err(MarketError::bad_request(
            "yank_reason_required",
            "A yank reason is required.",
        ));
    }
    let mut transaction = state
        .db
        .pool()
        .begin()
        .await
        .map_err(MarketError::internal)?;
    let release = sqlx::query("SELECT listing_id FROM releases WHERE id = ? AND yanked_at IS NULL")
        .bind(&release_id)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(MarketError::internal)?
        .ok_or_else(|| MarketError::not_found("Release was not found or is already yanked."))?;
    let listing_id: String = release.get("listing_id");
    sqlx::query("UPDATE releases SET yanked_at = ?, yank_reason = ? WHERE id = ?")
        .bind(Utc::now().timestamp())
        .bind(request.reason.trim())
        .bind(&release_id)
        .execute(&mut *transaction)
        .await
        .map_err(MarketError::internal)?;
    let fallback = sqlx::query(
        "SELECT id FROM releases
         WHERE listing_id = ? AND yanked_at IS NULL
         ORDER BY release_number DESC LIMIT 1",
    )
    .bind(&listing_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(MarketError::internal)?;
    if let Some(fallback) = fallback {
        let fallback_id: String = fallback.get("id");
        sqlx::query("UPDATE listings SET latest_release_id = ?, updated_at = ? WHERE id = ?")
            .bind(fallback_id)
            .bind(Utc::now().timestamp())
            .bind(&listing_id)
            .execute(&mut *transaction)
            .await
            .map_err(MarketError::internal)?;
    } else {
        sqlx::query(
            "UPDATE listings SET latest_release_id = NULL, is_published = 0, updated_at = ?
             WHERE id = ?",
        )
        .bind(Utc::now().timestamp())
        .bind(&listing_id)
        .execute(&mut *transaction)
        .await
        .map_err(MarketError::internal)?;
    }
    transaction.commit().await.map_err(MarketError::internal)?;
    insert_audit(
        &state,
        admin.user.internal_id,
        "release_yanked",
        "release",
        &release_id,
        serde_json::json!({ "reason": request.reason.trim() }),
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn unpublish_listing(
    State(state): State<Arc<MarketState>>,
    headers: HeaderMap,
    Path(listing_id): Path<String>,
    Json(request): Json<ModerationReason>,
) -> MarketResult<StatusCode> {
    let admin = require_admin_write(&state, &headers).await?;
    if request.reason.trim().is_empty() {
        return Err(MarketError::bad_request(
            "unpublish_reason_required",
            "An unpublish reason is required.",
        ));
    }
    let updated = sqlx::query(
        "UPDATE listings SET is_published = 0, updated_at = ?
         WHERE id = ? AND is_published = 1",
    )
    .bind(Utc::now().timestamp())
    .bind(&listing_id)
    .execute(state.db.pool())
    .await
    .map_err(MarketError::internal)?;
    if updated.rows_affected() != 1 {
        return Err(MarketError::not_found("Published listing was not found."));
    }
    insert_audit(
        &state,
        admin.user.internal_id,
        "listing_unpublished",
        "listing",
        &listing_id,
        serde_json::json!({ "reason": request.reason.trim() }),
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn put_rating(
    State(state): State<Arc<MarketState>>,
    headers: HeaderMap,
    Path(slug): Path<String>,
    Json(request): Json<RatingRequest>,
) -> MarketResult<Json<RatingAggregate>> {
    let auth = require_write_auth(&state, &headers).await?;
    if !(1..=5).contains(&request.value) {
        return Err(MarketError::bad_request(
            "invalid_rating",
            "Ratings must be an integer between 1 and 5.",
        ));
    }
    let listing_id = public_listing_id(&state, &slug).await?;
    let now = Utc::now().timestamp();
    sqlx::query(
        "INSERT INTO ratings(listing_id, user_id, value, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(listing_id, user_id) DO UPDATE SET
            value = excluded.value, updated_at = excluded.updated_at",
    )
    .bind(&listing_id)
    .bind(auth.user.internal_id)
    .bind(i64::from(request.value))
    .bind(now)
    .bind(now)
    .execute(state.db.pool())
    .await
    .map_err(MarketError::internal)?;
    Ok(Json(
        rating_aggregate(&state, &listing_id, Some(auth.user.internal_id)).await?,
    ))
}

async fn delete_rating(
    State(state): State<Arc<MarketState>>,
    headers: HeaderMap,
    Path(slug): Path<String>,
) -> MarketResult<Json<RatingAggregate>> {
    let auth = require_write_auth(&state, &headers).await?;
    let listing_id = public_listing_id(&state, &slug).await?;
    sqlx::query("DELETE FROM ratings WHERE listing_id = ? AND user_id = ?")
        .bind(&listing_id)
        .bind(auth.user.internal_id)
        .execute(state.db.pool())
        .await
        .map_err(MarketError::internal)?;
    Ok(Json(
        rating_aggregate(&state, &listing_id, Some(auth.user.internal_id)).await?,
    ))
}

async fn put_favorite(
    State(state): State<Arc<MarketState>>,
    headers: HeaderMap,
    Path(slug): Path<String>,
) -> MarketResult<Json<FavoriteAggregate>> {
    let auth = require_write_auth(&state, &headers).await?;
    let listing_id = public_listing_id(&state, &slug).await?;
    sqlx::query("INSERT OR IGNORE INTO favorites(listing_id, user_id, created_at) VALUES(?, ?, ?)")
        .bind(&listing_id)
        .bind(auth.user.internal_id)
        .bind(Utc::now().timestamp())
        .execute(state.db.pool())
        .await
        .map_err(MarketError::internal)?;
    Ok(Json(
        favorite_aggregate(&state, &listing_id, auth.user.internal_id).await?,
    ))
}

async fn delete_favorite(
    State(state): State<Arc<MarketState>>,
    headers: HeaderMap,
    Path(slug): Path<String>,
) -> MarketResult<Json<FavoriteAggregate>> {
    let auth = require_write_auth(&state, &headers).await?;
    let listing_id = public_listing_id(&state, &slug).await?;
    sqlx::query("DELETE FROM favorites WHERE listing_id = ? AND user_id = ?")
        .bind(&listing_id)
        .bind(auth.user.internal_id)
        .execute(state.db.pool())
        .await
        .map_err(MarketError::internal)?;
    Ok(Json(
        favorite_aggregate(&state, &listing_id, auth.user.internal_id).await?,
    ))
}

async fn summary_from_row(
    state: &MarketState,
    row: sqlx::sqlite::SqliteRow,
) -> MarketResult<MarketListingSummary> {
    let metadata: StoredSubmissionMetadata =
        serde_json::from_str(row.get("metadata_json")).map_err(MarketError::internal)?;
    let release_id: String = row.get("release_id");
    Ok(MarketListingSummary {
        listing_id: row.get("listing_id"),
        slug: row.get("slug"),
        name: metadata.name,
        description: metadata.description,
        icon: metadata.icon,
        category: metadata.category,
        tags: metadata.tags,
        owner: MarketUserSummary {
            account_id: Some(
                row.get::<Option<i64>, _>("github_id")
                    .map(|id| id.to_string())
                    .unwrap_or_else(|| format!("email-{}", row.get::<i64, _>("owner_identity_id"))),
            ),
            github_id: row.get::<Option<i64>, _>("github_id").unwrap_or_default(),
            login: row.get("login"),
            avatar_url: row.get("avatar_url"),
        },
        latest_release: row.get::<i64, _>("release_number") as u32,
        min_openbitfun_version: metadata.min_openbitfun_version,
        permissions: metadata.permissions,
        screenshot_urls: screenshot_urls_for_release(state, &release_id).await?,
        rating_average: row.get("rating_average"),
        rating_count: row.get::<i64, _>("rating_count") as u32,
        favorite_count: row.get::<i64, _>("favorite_count") as u32,
        download_count: row.get::<i64, _>("download_count") as u64,
        published_at: row.get("published_at"),
        i18n: metadata.i18n,
        is_favorited: Some(row.get::<i64, _>("is_favorited") != 0),
        my_rating: row
            .try_get::<Option<i64>, _>("my_rating")
            .map_err(MarketError::internal)?
            .map(|value| value as u8),
    })
}

async fn listing_detail_by_slug(
    state: &MarketState,
    slug: &str,
    user_id: i64,
) -> MarketResult<MarketListingDetail> {
    let row = sqlx::query(
        "SELECT l.id AS listing_id, l.slug, r.id AS release_id, r.release_number,
                r.metadata_json, r.package_sha256, r.package_size,
                r.review_bundle_hash, r.published_at,
                u.id AS owner_identity_id, u.github_id, COALESCE((SELECT email FROM email_identities WHERE user_id = u.id AND u.github_id IS NULL), u.login) AS login, u.avatar_url,
                COALESCE((SELECT AVG(value) FROM ratings WHERE listing_id = l.id), 0.0) AS rating_average,
                (SELECT COUNT(*) FROM ratings WHERE listing_id = l.id) AS rating_count,
                (SELECT COUNT(*) FROM favorites WHERE listing_id = l.id) AS favorite_count,
                (SELECT COUNT(*) FROM download_days WHERE listing_id = l.id) AS download_count,
                EXISTS(SELECT 1 FROM favorites WHERE listing_id = l.id AND user_id = ?) AS is_favorited,
                (SELECT value FROM ratings WHERE listing_id = l.id AND user_id = ?) AS my_rating
         FROM listings l
         JOIN releases r ON r.id = l.latest_release_id
         JOIN users u ON u.id = l.owner_user_id
         WHERE l.slug = ? AND l.is_published = 1 AND r.yanked_at IS NULL",
    )
    .bind(user_id)
    .bind(user_id)
    .bind(slug)
    .fetch_optional(state.db.pool())
    .await
    .map_err(MarketError::internal)?
    .ok_or_else(|| MarketError::not_found("MiniApp listing was not found."))?;
    let metadata: StoredSubmissionMetadata =
        serde_json::from_str(row.get("metadata_json")).map_err(MarketError::internal)?;
    let changelog = metadata.changelog.clone();
    let license = metadata.license.clone();
    let repository_url = metadata.repository_url.clone();
    let summary = summary_from_row(state, row).await?;
    let rows = sqlx::query(
        "SELECT id, listing_id, release_number, metadata_json, package_sha256, package_size,
                review_bundle_hash, published_at, yanked_at
         FROM releases WHERE listing_id = ? ORDER BY release_number DESC",
    )
    .bind(&summary.listing_id)
    .fetch_all(state.db.pool())
    .await
    .map_err(MarketError::internal)?;
    let releases = rows
        .into_iter()
        .map(release_from_row)
        .collect::<MarketResult<Vec<_>>>()?;
    Ok(MarketListingDetail {
        summary,
        changelog,
        license,
        repository_url,
        releases,
    })
}

fn release_from_row(row: sqlx::sqlite::SqliteRow) -> MarketResult<MarketRelease> {
    let metadata: StoredSubmissionMetadata =
        serde_json::from_str(row.get("metadata_json")).map_err(MarketError::internal)?;
    Ok(MarketRelease {
        release_id: row.get("id"),
        listing_id: row.get("listing_id"),
        release_number: row.get::<i64, _>("release_number") as u32,
        min_openbitfun_version: metadata.min_openbitfun_version,
        changelog: metadata.changelog,
        package_sha256: row.get("package_sha256"),
        package_size: row.get::<i64, _>("package_size") as u64,
        review_bundle_hash: row.get("review_bundle_hash"),
        permissions: metadata.permissions,
        published_at: row.get("published_at"),
        yanked: row
            .try_get::<Option<i64>, _>("yanked_at")
            .map_err(MarketError::internal)?
            .is_some(),
    })
}

async fn submission_by_id(
    state: &MarketState,
    submission_id: &str,
    user_id: i64,
    admin: bool,
) -> MarketResult<MarketSubmission> {
    let row = sqlx::query(
        "SELECT id, listing_id, slug, release_number, metadata_json, status,
                package_sha256, package_size, rejection_reason, created_at, updated_at,
                owner_user_id
         FROM submissions WHERE id = ?",
    )
    .bind(submission_id)
    .fetch_optional(state.db.pool())
    .await
    .map_err(MarketError::internal)?
    .ok_or_else(|| MarketError::not_found("Submission was not found."))?;
    if !admin && row.get::<i64, _>("owner_user_id") != user_id {
        return Err(MarketError::not_found("Submission was not found."));
    }
    submission_from_row(state, row).await
}

async fn admin_submission_by_id(
    state: &MarketState,
    submission_id: &str,
) -> MarketResult<AdminSubmissionSummary> {
    let row = sqlx::query(
        "SELECT s.id AS id, s.listing_id AS listing_id, s.slug AS slug,
                s.release_number AS release_number, s.metadata_json AS metadata_json,
                s.status AS status, s.package_sha256 AS package_sha256,
                s.package_size AS package_size, s.rejection_reason AS rejection_reason,
                s.created_at AS created_at, s.updated_at AS updated_at,
                s.owner_user_id AS owner_user_id, s.submitted_at AS submitted_at,
                u.github_id AS submitter_github_id, COALESCE((SELECT email FROM email_identities WHERE user_id = u.id AND u.github_id IS NULL), u.login) AS submitter_login,
                u.avatar_url AS submitter_avatar_url
         FROM submissions s
         JOIN users u ON u.id = s.owner_user_id
         WHERE s.id = ?",
    )
    .bind(submission_id)
    .fetch_optional(state.db.pool())
    .await
    .map_err(MarketError::internal)?
    .ok_or_else(|| MarketError::not_found("Submission was not found."))?;
    admin_submission_from_row(state, row).await
}

async fn admin_submission_from_row(
    state: &MarketState,
    row: sqlx::sqlite::SqliteRow,
) -> MarketResult<AdminSubmissionSummary> {
    let submitter = MarketUserSummary {
        account_id: None,
        github_id: row
            .get::<Option<i64>, _>("submitter_github_id")
            .unwrap_or_default(),
        login: row.get("submitter_login"),
        avatar_url: row.get("submitter_avatar_url"),
    };
    let submitted_at = row
        .try_get::<Option<i64>, _>("submitted_at")
        .map_err(MarketError::internal)?;
    let submission = submission_from_row(state, row).await?;
    Ok(AdminSubmissionSummary {
        submission,
        submitter,
        submitted_at,
    })
}

async fn submission_from_row(
    state: &MarketState,
    row: sqlx::sqlite::SqliteRow,
) -> MarketResult<MarketSubmission> {
    let metadata: StoredSubmissionMetadata =
        serde_json::from_str(row.get("metadata_json")).map_err(MarketError::internal)?;
    let submission_id: String = row.get("id");
    Ok(MarketSubmission {
        submission_id: submission_id.clone(),
        listing_id: row
            .try_get::<Option<String>, _>("listing_id")
            .map_err(MarketError::internal)?,
        slug: row.get("slug"),
        release_number: row.get::<i64, _>("release_number") as u32,
        name: metadata.name,
        description: metadata.description,
        icon: metadata.icon,
        category: metadata.category,
        tags: metadata.tags,
        min_openbitfun_version: metadata.min_openbitfun_version,
        changelog: metadata.changelog,
        license: metadata.license,
        repository_url: metadata.repository_url,
        permissions: metadata.permissions,
        status: parse_submission_status(row.get::<String, _>("status").as_str())?,
        package_sha256: row
            .try_get::<Option<String>, _>("package_sha256")
            .map_err(MarketError::internal)?,
        package_size: row
            .try_get::<Option<i64>, _>("package_size")
            .map_err(MarketError::internal)?
            .map(|value| value as u64),
        screenshot_urls: screenshot_urls_for_submission(state, &submission_id).await?,
        rejection_reason: row
            .try_get::<Option<String>, _>("rejection_reason")
            .map_err(MarketError::internal)?,
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    })
}

async fn list_submissions(
    state: &MarketState,
    owner_id: Option<i64>,
    status: Option<MarketSubmissionStatus>,
    admin: bool,
) -> MarketResult<Vec<MarketSubmission>> {
    let mut builder = QueryBuilder::<Sqlite>::new(
        "SELECT id, listing_id, slug, release_number, metadata_json, status,
                package_sha256, package_size, rejection_reason, created_at, updated_at,
                owner_user_id
         FROM submissions WHERE 1 = 1",
    );
    if let Some(owner_id) = owner_id {
        builder.push(" AND owner_user_id = ");
        builder.push_bind(owner_id);
    }
    if let Some(status) = status {
        builder.push(" AND status = ");
        builder.push_bind(status_string(status));
    }
    builder.push(" ORDER BY updated_at DESC LIMIT 200");
    let rows = builder
        .build()
        .fetch_all(state.db.pool())
        .await
        .map_err(MarketError::internal)?;
    let mut submissions = Vec::with_capacity(rows.len());
    for row in rows {
        if !admin && owner_id.is_none() {
            continue;
        }
        submissions.push(submission_from_row(state, row).await?);
    }
    Ok(submissions)
}

async fn list_admin_submission_summaries(
    state: &MarketState,
    status: Option<MarketSubmissionStatus>,
) -> MarketResult<Vec<AdminSubmissionSummary>> {
    let mut builder = QueryBuilder::<Sqlite>::new(
        "SELECT s.id AS id, s.listing_id AS listing_id, s.slug AS slug,
                s.release_number AS release_number, s.metadata_json AS metadata_json,
                s.status AS status, s.package_sha256 AS package_sha256,
                s.package_size AS package_size, s.rejection_reason AS rejection_reason,
                s.created_at AS created_at, s.updated_at AS updated_at,
                s.owner_user_id AS owner_user_id, s.submitted_at AS submitted_at,
                u.github_id AS submitter_github_id, COALESCE((SELECT email FROM email_identities WHERE user_id = u.id AND u.github_id IS NULL), u.login) AS submitter_login,
                u.avatar_url AS submitter_avatar_url
         FROM submissions s
         JOIN users u ON u.id = s.owner_user_id
         WHERE 1 = 1",
    );
    if let Some(status) = status {
        builder.push(" AND s.status = ");
        builder.push_bind(status_string(status));
    }
    builder.push(" ORDER BY s.updated_at DESC LIMIT 200");
    let rows = builder
        .build()
        .fetch_all(state.db.pool())
        .await
        .map_err(MarketError::internal)?;
    let mut submissions = Vec::with_capacity(rows.len());
    for row in rows {
        submissions.push(admin_submission_from_row(state, row).await?);
    }
    Ok(submissions)
}

async fn approve_submission(
    state: &MarketState,
    reviewer: &AuthenticatedUser,
    submission_id: &str,
) -> MarketResult<()> {
    let mut transaction = state
        .db
        .pool()
        .begin()
        .await
        .map_err(MarketError::internal)?;
    let submission = sqlx::query(
        "SELECT s.listing_id AS listing_id, s.owner_user_id AS owner_user_id,
                s.slug AS slug, s.release_number AS release_number,
                s.metadata_json AS metadata_json, s.package_sha256 AS package_sha256,
                s.package_size AS package_size, u.github_id AS submitter_github_id
         FROM submissions s
         JOIN users u ON u.id = s.owner_user_id
         WHERE s.id = ? AND s.status = 'submitted'",
    )
    .bind(submission_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(MarketError::internal)?
    .ok_or_else(|| {
        MarketError::conflict(
            "submission_not_reviewable",
            "Only submitted entries may be approved.",
        )
    })?;
    let owner_user_id: i64 = submission.get("owner_user_id");
    let submitter_is_admin = submission
        .get::<Option<i64>, _>("submitter_github_id")
        .is_some_and(|id| id > 0 && state.config.admin_github_ids.contains(&id));
    let slug: String = submission.get("slug");
    let release_number: i64 = submission.get("release_number");
    let metadata_json: String = submission.get("metadata_json");
    let package_sha256 = submission
        .try_get::<Option<String>, _>("package_sha256")
        .map_err(MarketError::internal)?
        .ok_or_else(|| MarketError::internal("Submitted entry is missing its package hash"))?;
    let package_size = submission
        .try_get::<Option<i64>, _>("package_size")
        .map_err(MarketError::internal)?
        .ok_or_else(|| MarketError::internal("Submitted entry is missing its package size"))?;
    let mut listing_id = submission
        .try_get::<Option<String>, _>("listing_id")
        .map_err(MarketError::internal)?;
    let now = Utc::now().timestamp();

    if let Some(existing_id) = listing_id.as_deref() {
        let listing = sqlx::query(
            "SELECT owner_user_id, slug,
                    COALESCE((SELECT MAX(release_number) FROM releases WHERE listing_id = listings.id), 0) AS latest
             FROM listings WHERE id = ?",
        )
        .bind(existing_id)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(MarketError::internal)?
        .ok_or_else(|| MarketError::not_found("The target listing no longer exists."))?;
        if (listing.get::<i64, _>("owner_user_id") != owner_user_id && !submitter_is_admin)
            || listing.get::<String, _>("slug") != slug
            || release_number != listing.get::<i64, _>("latest") + 1
        {
            return Err(MarketError::conflict(
                "release_conflict",
                "The listing changed while this submission was awaiting review.",
            ));
        }
    } else {
        let id = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO listings(id, slug, owner_user_id, is_published, created_at, updated_at)
             VALUES(?, ?, ?, 0, ?, ?)",
        )
        .bind(&id)
        .bind(&slug)
        .bind(owner_user_id)
        .bind(now)
        .bind(now)
        .execute(&mut *transaction)
        .await
        .map_err(map_unique_submission_error)?;
        listing_id = Some(id);
    }
    let listing_id =
        listing_id.ok_or_else(|| MarketError::internal("Approval has no listing id"))?;
    let screenshot_rows =
        sqlx::query("SELECT sha256 FROM screenshots WHERE submission_id = ? ORDER BY position")
            .bind(submission_id)
            .fetch_all(&mut *transaction)
            .await
            .map_err(MarketError::internal)?;
    if screenshot_rows.is_empty() {
        return Err(MarketError::conflict(
            "screenshot_required",
            "The submission lost its marketplace images before approval.",
        ));
    }
    let screenshot_hashes = screenshot_rows
        .iter()
        .map(|row| row.get::<String, _>("sha256"))
        .collect::<Vec<_>>();
    let review_bundle_hash =
        compute_review_bundle_hash(&package_sha256, &metadata_json, &screenshot_hashes);
    let release_id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO releases(
            id, listing_id, submission_id, release_number, metadata_json,
            package_sha256, package_size, review_bundle_hash, published_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&release_id)
    .bind(&listing_id)
    .bind(submission_id)
    .bind(release_number)
    .bind(&metadata_json)
    .bind(&package_sha256)
    .bind(package_size)
    .bind(&review_bundle_hash)
    .bind(now)
    .execute(&mut *transaction)
    .await
    .map_err(MarketError::internal)?;
    sqlx::query("UPDATE screenshots SET release_id = ? WHERE submission_id = ?")
        .bind(&release_id)
        .bind(submission_id)
        .execute(&mut *transaction)
        .await
        .map_err(MarketError::internal)?;
    sqlx::query(
        "UPDATE listings SET latest_release_id = ?, is_published = 1, updated_at = ?
         WHERE id = ?",
    )
    .bind(&release_id)
    .bind(now)
    .bind(&listing_id)
    .execute(&mut *transaction)
    .await
    .map_err(MarketError::internal)?;
    sqlx::query(
        "UPDATE submissions
         SET listing_id = ?, status = 'approved', reviewer_user_id = ?,
             reviewed_at = ?, updated_at = ?
         WHERE id = ?",
    )
    .bind(&listing_id)
    .bind(reviewer.internal_id)
    .bind(now)
    .bind(now)
    .bind(submission_id)
    .execute(&mut *transaction)
    .await
    .map_err(MarketError::internal)?;
    let metadata: StoredSubmissionMetadata =
        serde_json::from_str(&metadata_json).map_err(MarketError::internal)?;
    let (search_names, search_descriptions, search_tags) = search_text(&metadata);
    sqlx::query("DELETE FROM listing_search WHERE listing_id = ?")
        .bind(&listing_id)
        .execute(&mut *transaction)
        .await
        .map_err(MarketError::internal)?;
    sqlx::query(
        "INSERT INTO listing_search(listing_id, name, description, tags, category)
         VALUES(?, ?, ?, ?, ?)",
    )
    .bind(&listing_id)
    .bind(search_names)
    .bind(search_descriptions)
    .bind(search_tags)
    .bind(&metadata.category)
    .execute(&mut *transaction)
    .await
    .map_err(MarketError::internal)?;
    transaction.commit().await.map_err(MarketError::internal)?;
    insert_audit(
        state,
        reviewer.internal_id,
        "submission_approved",
        "submission",
        submission_id,
        serde_json::json!({
            "listingId": listing_id,
            "releaseId": release_id,
            "reviewBundleHash": review_bundle_hash,
        }),
    )
    .await
}

async fn screenshot_urls_for_release(
    state: &MarketState,
    release_id: &str,
) -> MarketResult<Vec<String>> {
    let rows = sqlx::query("SELECT sha256 FROM screenshots WHERE release_id = ? ORDER BY position")
        .bind(release_id)
        .fetch_all(state.db.pool())
        .await
        .map_err(MarketError::internal)?;
    Ok(rows
        .into_iter()
        .map(|row| screenshot_url(state, row.get::<String, _>("sha256").as_str()))
        .collect())
}

async fn screenshot_urls_for_submission(
    state: &MarketState,
    submission_id: &str,
) -> MarketResult<Vec<String>> {
    let rows =
        sqlx::query("SELECT sha256 FROM screenshots WHERE submission_id = ? ORDER BY position")
            .bind(submission_id)
            .fetch_all(state.db.pool())
            .await
            .map_err(MarketError::internal)?;
    Ok(rows
        .into_iter()
        .map(|row| screenshot_url(state, row.get::<String, _>("sha256").as_str()))
        .collect())
}

fn screenshot_url(state: &MarketState, sha256: &str) -> String {
    format!(
        "{}/api/v1/screenshots/{}",
        state.config.public_base_url, sha256
    )
}

async fn validate_listing_ownership_and_release(
    state: &MarketState,
    user: &AuthenticatedUser,
    listing_id: Option<&str>,
    slug: &str,
    release_number: u32,
) -> MarketResult<Option<String>> {
    if let Some(listing_id) = listing_id {
        let row = sqlx::query(
            "SELECT owner_user_id, slug,
                    COALESCE((SELECT MAX(release_number) FROM releases WHERE listing_id = listings.id), 0) AS latest
             FROM listings WHERE id = ?",
        )
        .bind(listing_id)
        .fetch_optional(state.db.pool())
        .await
        .map_err(MarketError::internal)?
        .ok_or_else(|| MarketError::not_found("Listing was not found."))?;
        if row.get::<i64, _>("owner_user_id") != user.internal_id && !state.auth.is_admin(user) {
            return Err(MarketError::forbidden(
                "Only the listing owner or an administrator may publish a new release.",
            ));
        }
        if row.get::<String, _>("slug") != slug {
            return Err(MarketError::bad_request(
                "slug_immutable",
                "Listing slugs cannot be changed.",
            ));
        }
        let next_release = row.get::<i64, _>("latest") + 1;
        if i64::from(release_number) != next_release {
            return Err(MarketError::conflict(
                "invalid_release_number",
                format!("The next release number must be {next_release}."),
            ));
        }
        return Ok(Some(listing_id.to_string()));
    }
    if release_number != 1 {
        return Err(MarketError::bad_request(
            "invalid_first_release",
            "A new listing must start at release 1.",
        ));
    }
    let exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM listings WHERE slug = ?")
        .bind(slug)
        .fetch_one(state.db.pool())
        .await
        .map_err(MarketError::internal)?;
    if exists > 0 {
        return Err(MarketError::conflict(
            "slug_taken",
            "This marketplace slug is already in use.",
        ));
    }
    Ok(None)
}

fn validate_submission_request(request: &MarketSubmissionDraftRequest) -> MarketResult<()> {
    if !validate_market_slug(&request.slug) {
        return Err(MarketError::bad_request(
            "invalid_slug",
            "Slugs must contain 3–63 lowercase letters, numbers, or hyphens.",
        ));
    }
    if !validate_market_category(&request.category) {
        return Err(MarketError::bad_request(
            "invalid_category",
            "The selected category is not supported.",
        ));
    }
    validate_min_openbitfun_version(&request.min_openbitfun_version)?;
    if request.name.trim().is_empty()
        || request.description.trim().is_empty()
        || request.changelog.trim().is_empty()
    {
        return Err(MarketError::bad_request(
            "missing_submission_metadata",
            "Name, description, and changelog are required.",
        ));
    }
    if request.name.chars().count() > 80
        || request.description.chars().count() > 500
        || request.icon.chars().count() > 32
        || request.changelog.chars().count() > 4_000
        || request.tags.len() > 10
        || request.tags.iter().any(|tag| tag.chars().count() > 32)
    {
        return Err(MarketError::bad_request(
            "submission_metadata_too_large",
            "Submission metadata exceeds the marketplace limits.",
        ));
    }
    if !request.license.is_declared()
        || (request.license.spdx_expression.is_some() && request.license.custom_url.is_some())
    {
        return Err(MarketError::bad_request(
            "invalid_license",
            "Declare one SPDX expression or one custom HTTPS license URL.",
        ));
    }
    if request
        .license
        .spdx_expression
        .as_ref()
        .is_some_and(|value| value.chars().count() > 200)
    {
        return Err(MarketError::bad_request(
            "invalid_license",
            "The SPDX expression is too long.",
        ));
    }
    for url in [
        request.license.custom_url.as_deref(),
        request.repository_url.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        let parsed = url::Url::parse(url).map_err(|_| {
            MarketError::bad_request("invalid_url", "License and repository URLs must be valid.")
        })?;
        if parsed.scheme() != "https" {
            return Err(MarketError::bad_request(
                "insecure_url",
                "License and repository URLs must use HTTPS.",
            ));
        }
        if url.len() > 2_048 || parsed.username() != "" || parsed.password().is_some() {
            return Err(MarketError::bad_request(
                "invalid_url",
                "License and repository URLs must not contain credentials and must fit in 2048 bytes.",
            ));
        }
    }
    Ok(())
}

async fn require_write_auth(state: &MarketState, headers: &HeaderMap) -> MarketResult<RequestAuth> {
    let auth = state.auth.require_auth(headers).await?;
    state.auth.require_csrf(headers, &auth)?;
    Ok(auth)
}

async fn require_submission_write_auth(
    state: &MarketState,
    headers: &HeaderMap,
) -> MarketResult<RequestAuth> {
    let auth = state.auth.require_auth(headers).await?;
    if !state.config.web_submissions_enabled && matches!(&auth.kind, RequestAuthKind::Web { .. }) {
        return Err(MarketError::new(
            StatusCode::FORBIDDEN,
            "web_submissions_disabled",
            "Web submissions are disabled. Use OpenBitFun Desktop to submit MiniApps.",
        ));
    }
    state.auth.require_csrf(headers, &auth)?;
    Ok(auth)
}

async fn require_admin(state: &MarketState, headers: &HeaderMap) -> MarketResult<RequestAuth> {
    let auth = state.auth.require_auth(headers).await?;
    if !state.auth.is_admin(&auth.user) {
        return Err(MarketError::forbidden(
            "This marketplace action requires an administrator.",
        ));
    }
    Ok(auth)
}

async fn require_admin_write(
    state: &MarketState,
    headers: &HeaderMap,
) -> MarketResult<RequestAuth> {
    let auth = require_admin(state, headers).await?;
    state.auth.require_csrf(headers, &auth)?;
    Ok(auth)
}

fn ensure_public_browse(state: &MarketState, auth: Option<&RequestAuth>) -> MarketResult<()> {
    if state.config.public_browse || auth.is_some_and(|auth| state.auth.is_admin(&auth.user)) {
        Ok(())
    } else {
        Err(MarketError::service_unavailable(
            "market_not_public",
            "The MiniApp marketplace is not open to the public yet.",
        ))
    }
}

async fn public_listing_id(state: &MarketState, slug: &str) -> MarketResult<String> {
    sqlx::query_scalar(
        "SELECT id FROM listings WHERE slug = ? AND is_published = 1 AND latest_release_id IS NOT NULL",
    )
    .bind(slug)
    .fetch_optional(state.db.pool())
    .await
    .map_err(MarketError::internal)?
    .ok_or_else(|| MarketError::not_found("MiniApp listing was not found."))
}

async fn rating_aggregate(
    state: &MarketState,
    listing_id: &str,
    user_id: Option<i64>,
) -> MarketResult<RatingAggregate> {
    let row = sqlx::query(
        "SELECT COALESCE(AVG(value), 0.0) AS average, COUNT(*) AS count,
                (SELECT value FROM ratings WHERE listing_id = ? AND user_id = ?) AS my_rating
         FROM ratings WHERE listing_id = ?",
    )
    .bind(listing_id)
    .bind(user_id.unwrap_or(-1))
    .bind(listing_id)
    .fetch_one(state.db.pool())
    .await
    .map_err(MarketError::internal)?;
    Ok(RatingAggregate {
        average: row.get("average"),
        count: row.get::<i64, _>("count") as u32,
        my_rating: row
            .try_get::<Option<i64>, _>("my_rating")
            .map_err(MarketError::internal)?
            .map(|value| value as u8),
    })
}

async fn favorite_aggregate(
    state: &MarketState,
    listing_id: &str,
    user_id: i64,
) -> MarketResult<FavoriteAggregate> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM favorites WHERE listing_id = ?")
        .bind(listing_id)
        .fetch_one(state.db.pool())
        .await
        .map_err(MarketError::internal)?;
    let is_favorited: i64 = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM favorites WHERE listing_id = ? AND user_id = ?)",
    )
    .bind(listing_id)
    .bind(user_id)
    .fetch_one(state.db.pool())
    .await
    .map_err(MarketError::internal)?;
    Ok(FavoriteAggregate {
        count: count as u32,
        is_favorited: is_favorited != 0,
    })
}

async fn record_download(
    state: &MarketState,
    headers: &HeaderMap,
    listing_id: &str,
) -> MarketResult<()> {
    let day = Utc::now().format("%Y-%m-%d").to_string();
    let visitor = headers
        .get("x-forwarded-for")
        .or_else(|| headers.get("x-real-ip"))
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .unwrap_or("unknown");
    let user_agent = headers
        .get(header::USER_AGENT)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("unknown");
    let visitor_hash = hex::encode(Sha256::digest(
        format!(
            "{}\0{}\0{}\0{}",
            state.config.session_secret, day, visitor, user_agent
        )
        .as_bytes(),
    ));
    sqlx::query(
        "INSERT OR IGNORE INTO download_days(listing_id, day, visitor_hash, created_at)
         VALUES(?, ?, ?, ?)",
    )
    .bind(listing_id)
    .bind(day)
    .bind(visitor_hash)
    .bind(Utc::now().timestamp())
    .execute(state.db.pool())
    .await
    .map_err(MarketError::internal)?;
    Ok(())
}

async fn insert_audit(
    state: &MarketState,
    actor_user_id: i64,
    action: &str,
    target_kind: &str,
    target_id: &str,
    details: serde_json::Value,
) -> MarketResult<()> {
    sqlx::query(
        "INSERT INTO audit_log(
            id, actor_user_id, action, target_kind, target_id, details_json, created_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(actor_user_id)
    .bind(action)
    .bind(target_kind)
    .bind(target_id)
    .bind(details.to_string())
    .bind(Utc::now().timestamp())
    .execute(state.db.pool())
    .await
    .map_err(MarketError::internal)?;
    Ok(())
}

fn parse_submission_status(value: &str) -> MarketResult<MarketSubmissionStatus> {
    match value {
        "draft" => Ok(MarketSubmissionStatus::Draft),
        "submitted" => Ok(MarketSubmissionStatus::Submitted),
        "approved" => Ok(MarketSubmissionStatus::Approved),
        "rejected" => Ok(MarketSubmissionStatus::Rejected),
        "withdrawn" => Ok(MarketSubmissionStatus::Withdrawn),
        _ => Err(MarketError::internal(format!(
            "Unknown submission status: {value}"
        ))),
    }
}

fn status_string(status: MarketSubmissionStatus) -> &'static str {
    match status {
        MarketSubmissionStatus::Draft => "draft",
        MarketSubmissionStatus::Submitted => "submitted",
        MarketSubmissionStatus::Approved => "approved",
        MarketSubmissionStatus::Rejected => "rejected",
        MarketSubmissionStatus::Withdrawn => "withdrawn",
    }
}

fn canonical_metadata_json(metadata: &StoredSubmissionMetadata) -> MarketResult<String> {
    let value = serde_json::to_value(metadata).map_err(MarketError::internal)?;
    serde_json::to_string(&value).map_err(MarketError::internal)
}

fn search_text(metadata: &StoredSubmissionMetadata) -> (String, String, String) {
    let mut names = vec![metadata.name.clone()];
    let mut descriptions = vec![metadata.description.clone()];
    let mut tags = metadata.tags.clone();
    if let Some(i18n) = metadata.i18n.as_ref() {
        let mut locales = i18n.locales.iter().collect::<Vec<_>>();
        locales.sort_by_key(|(locale, _)| *locale);
        for (_, strings) in locales {
            if let Some(name) = strings.name.as_ref() {
                names.push(name.clone());
            }
            if let Some(description) = strings.description.as_ref() {
                descriptions.push(description.clone());
            }
            if let Some(localized_tags) = strings.tags.as_ref() {
                tags.extend(localized_tags.iter().cloned());
            }
        }
    }
    (names.join(" "), descriptions.join(" "), tags.join(" "))
}

fn decode_cursor(cursor: Option<&str>) -> MarketResult<u64> {
    let Some(cursor) = cursor else {
        return Ok(0);
    };
    let decoded = URL_SAFE_NO_PAD.decode(cursor).map_err(|_| {
        MarketError::bad_request("invalid_cursor", "The pagination cursor is invalid.")
    })?;
    let text = String::from_utf8(decoded).map_err(|_| {
        MarketError::bad_request("invalid_cursor", "The pagination cursor is invalid.")
    })?;
    text.parse::<u64>().map_err(|_| {
        MarketError::bad_request("invalid_cursor", "The pagination cursor is invalid.")
    })
}

fn encode_cursor(offset: u64) -> String {
    URL_SAFE_NO_PAD.encode(offset.to_string())
}

fn fts_query(value: &str) -> String {
    value
        .split_whitespace()
        .filter(|term| !term.is_empty())
        .map(|term| format!("\"{}\"*", term.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" ")
}

fn safe_filename(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || *character == '-')
        .collect()
}

fn map_unique_submission_error(error: sqlx::Error) -> MarketError {
    if error.to_string().contains("UNIQUE constraint failed") {
        MarketError::conflict(
            "market_conflict",
            "The marketplace record conflicts with an existing listing or release.",
        )
    } else {
        MarketError::internal(error)
    }
}

struct HeaderNameExt;

impl HeaderNameExt {
    fn checksum() -> axum::http::HeaderName {
        axum::http::HeaderName::from_static("x-checksum-sha256")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;
    use std::collections::HashSet;

    #[test]
    fn oauth_start_query_accepts_canonical_and_legacy_return_target_names() {
        for parameter in ["returnTo", "return_to"] {
            let uri = format!("/auth/github/start?{parameter}=%2Fskin%2Fadmin")
                .parse()
                .unwrap();
            let Query(query) = Query::<OAuthStartQuery>::try_from_uri(&uri).unwrap();
            assert_eq!(query.return_to.as_deref(), Some("/skin/admin"));
        }
    }

    #[test]
    fn review_diff_covers_added_changed_and_removed_files() {
        let previous = BTreeMap::from([
            ("source/removed.js".to_string(), "old\n".to_string()),
            ("source/ui.js".to_string(), "before\n".to_string()),
        ]);
        let current = BTreeMap::from([
            ("source/added.js".to_string(), "new\n".to_string()),
            ("source/ui.js".to_string(), "after\n".to_string()),
        ]);

        let diffs = build_source_diffs(&previous, &current);

        assert!(diffs["source/added.js"].contains("+new"));
        assert!(diffs["source/removed.js"].contains("-old"));
        assert!(diffs["source/ui.js"].contains("-before"));
        assert!(diffs["source/ui.js"].contains("+after"));
    }

    #[test]
    fn review_metadata_is_canonical_and_search_includes_locales() {
        let mut first_locales = std::collections::HashMap::new();
        first_locales.insert(
            "zh-CN".to_string(),
            openbitfun_product_domains::miniapp::types::MiniAppLocaleStrings {
                name: Some("正则工具".to_string()),
                description: Some("本地测试".to_string()),
                tags: Some(vec!["开发".to_string()]),
            },
        );
        first_locales.insert(
            "en-US".to_string(),
            openbitfun_product_domains::miniapp::types::MiniAppLocaleStrings {
                name: Some("Regex Tool".to_string()),
                description: None,
                tags: None,
            },
        );
        let metadata = StoredSubmissionMetadata {
            name: "Default".to_string(),
            description: "Default description".to_string(),
            icon: ".*".to_string(),
            category: "developer".to_string(),
            tags: vec!["regex".to_string()],
            min_openbitfun_version: "1.0.0".to_string(),
            changelog: "Initial".to_string(),
            license: MarketLicense {
                spdx_expression: Some("MIT".to_string()),
                custom_url: None,
            },
            repository_url: None,
            permissions: MiniAppPermissions::default(),
            i18n: Some(MiniAppI18n {
                locales: first_locales,
            }),
        };
        let json = canonical_metadata_json(&metadata).unwrap();
        assert_eq!(json, canonical_metadata_json(&metadata).unwrap());
        let (names, descriptions, tags) = search_text(&metadata);
        assert!(names.contains("Regex Tool"));
        assert!(names.contains("正则工具"));
        assert!(descriptions.contains("本地测试"));
        assert!(tags.contains("开发"));
    }

    #[tokio::test]
    async fn approval_browse_search_and_yank_form_one_atomic_market_flow() {
        let temporary = tempfile::tempdir().unwrap();
        let config = MarketConfig {
            bind: "127.0.0.1:0".parse().unwrap(),
            public_base_url: "https://market.openbitfun.com/miniapp".to_string(),
            database_path: temporary.path().join("market.sqlite"),
            artifact_dir: temporary.path().join("artifacts"),
            web_dir: temporary.path().join("web"),
            github_callback_url: None,
            github_client_id: Some("client-id".to_string()),
            github_client_secret: Some("client-secret".to_string()),
            session_secret: "test-session-secret-at-least-24".to_string(),
            admin_github_ids: HashSet::from([24753352]),
            public_browse: true,
            web_submissions_enabled: false,
        };
        let db = Database::open(&config.database_path).await.unwrap();
        let artifacts = ArtifactStore::open(config.artifact_dir.clone())
            .await
            .unwrap();
        let auth = AuthService::new(config.clone(), db.clone()).unwrap();
        let state = Arc::new(MarketState {
            config,
            db: db.clone(),
            artifacts,
            auth,
        });
        let owner = db
            .upsert_github_user(
                24753352,
                "bobleer",
                "https://avatars.githubusercontent.com/u/24753352",
            )
            .await
            .unwrap();
        db.create_api_token(
            owner.internal_id,
            "admin-access-token",
            "access",
            "admin-token-family",
            (Utc::now() + chrono::Duration::hours(1)).timestamp(),
        )
        .await
        .unwrap();

        let metadata = StoredSubmissionMetadata {
            name: "Regex Workshop".to_string(),
            description: "A self-contained regular expression workbench.".to_string(),
            icon: ".*".to_string(),
            category: "developer".to_string(),
            tags: vec!["regex".to_string(), "offline".to_string()],
            min_openbitfun_version: "1.0.0".to_string(),
            changelog: "Initial reviewed release.".to_string(),
            license: MarketLicense {
                spdx_expression: Some("MIT".to_string()),
                custom_url: None,
            },
            repository_url: Some("https://github.com/openbitfun/openbitfun".to_string()),
            permissions: MiniAppPermissions {
                node: Some(NodePermissions {
                    enabled: false,
                    max_memory_mb: None,
                    timeout_ms: None,
                }),
                ..MiniAppPermissions::default()
            },
            i18n: None,
        };
        let submission_id = Uuid::new_v4().to_string();
        let now = Utc::now().timestamp();
        sqlx::query(
            "INSERT INTO submissions(
                id, owner_user_id, slug, release_number, metadata_json, status,
                package_sha256, package_size, submitted_at, created_at, updated_at
             ) VALUES(?, ?, ?, 1, ?, 'submitted', ?, 128, ?, ?, ?)",
        )
        .bind(&submission_id)
        .bind(owner.internal_id)
        .bind("regex-workshop")
        .bind(canonical_metadata_json(&metadata).unwrap())
        .bind("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        .bind(now)
        .bind(now)
        .bind(now)
        .execute(db.pool())
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO screenshots(
                id, submission_id, position, sha256, media_type, size_bytes,
                width, height, created_at
             ) VALUES(?, ?, 0, ?, 'image/webp', 64, 1200, 800, ?)",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(&submission_id)
        .bind("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
        .bind(now)
        .execute(db.pool())
        .await
        .unwrap();

        let queue = list_admin_submission_summaries(
            state.as_ref(),
            Some(MarketSubmissionStatus::Submitted),
        )
        .await
        .unwrap();
        assert_eq!(queue.len(), 1);
        assert_eq!(queue[0].submitter.login, "bobleer");
        assert_eq!(queue[0].submitted_at, Some(now));
        let queue_item = serde_json::to_value(&queue[0]).unwrap();
        assert_eq!(queue_item["name"], "Regex Workshop");
        assert_eq!(queue_item["submitter"]["githubId"], 24753352);
        assert_eq!(queue_item["submittedAt"], now);

        let admin_submission = admin_submission_by_id(state.as_ref(), &submission_id)
            .await
            .unwrap();
        assert_eq!(admin_submission.submitter.login, "bobleer");
        assert_eq!(admin_submission.submitted_at, Some(now));

        approve_submission(state.as_ref(), &owner, &submission_id)
            .await
            .unwrap();

        let page = list_listings(
            State(state.clone()),
            HeaderMap::new(),
            Query(ListingQuery {
                q: Some("Regex".to_string()),
                category: Some("developer".to_string()),
                sort: Some(MarketSort::Newest),
                cursor: None,
                limit: Some(10),
            }),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].slug, "regex-workshop");
        assert_eq!(page.items[0].latest_release, 1);
        assert_eq!(page.items[0].screenshot_urls.len(), 1);

        let detail = listing_detail_by_slug(state.as_ref(), "regex-workshop", -1)
            .await
            .unwrap();
        assert_eq!(detail.releases.len(), 1);
        assert_eq!(
            detail.releases[0].review_bundle_hash,
            compute_review_bundle_hash(
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                &canonical_metadata_json(&metadata).unwrap(),
                &["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_string()],
            )
        );

        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer admin-access-token"),
        );
        assert_eq!(
            yank_release(
                State(state.clone()),
                headers,
                Path(detail.releases[0].release_id.clone()),
                Json(ModerationReason {
                    reason: "Security response test".to_string(),
                }),
            )
            .await
            .unwrap(),
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            listing_detail_by_slug(state.as_ref(), "regex-workshop", -1)
                .await
                .unwrap_err()
                .status,
            StatusCode::NOT_FOUND
        );
        let audit_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM audit_log WHERE target_kind IN ('submission', 'release')",
        )
        .fetch_one(db.pool())
        .await
        .unwrap();
        assert_eq!(audit_count, 2);
    }

    #[tokio::test]
    async fn administrator_can_publish_update_without_reassigning_listing_owner() {
        let temporary = tempfile::tempdir().unwrap();
        let config = MarketConfig {
            bind: "127.0.0.1:0".parse().unwrap(),
            public_base_url: "https://market.openbitfun.com/miniapp".to_string(),
            database_path: temporary.path().join("market.sqlite"),
            artifact_dir: temporary.path().join("artifacts"),
            web_dir: temporary.path().join("web"),
            github_callback_url: None,
            github_client_id: Some("client-id".to_string()),
            github_client_secret: Some("client-secret".to_string()),
            session_secret: "test-session-secret-at-least-24".to_string(),
            admin_github_ids: HashSet::from([24753352]),
            public_browse: true,
            web_submissions_enabled: false,
        };
        let db = Database::open(&config.database_path).await.unwrap();
        let artifacts = ArtifactStore::open(config.artifact_dir.clone())
            .await
            .unwrap();
        let auth = AuthService::new(config.clone(), db.clone()).unwrap();
        let state = Arc::new(MarketState {
            config,
            db: db.clone(),
            artifacts,
            auth,
        });
        let original_owner = db
            .upsert_github_user(1001, "original-owner", "https://example.com/owner.png")
            .await
            .unwrap();
        let administrator = db
            .upsert_github_user(24753352, "administrator", "https://example.com/admin.png")
            .await
            .unwrap();
        let unrelated_user = db
            .upsert_github_user(1002, "unrelated-user", "https://example.com/user.png")
            .await
            .unwrap();
        let metadata = StoredSubmissionMetadata {
            name: "Owner Preserving App".to_string(),
            description: "Verifies delegated release publishing.".to_string(),
            icon: "box".to_string(),
            category: "utilities".to_string(),
            tags: vec!["ownership".to_string()],
            min_openbitfun_version: "1.0.0".to_string(),
            changelog: "Initial release.".to_string(),
            license: MarketLicense {
                spdx_expression: Some("MIT".to_string()),
                custom_url: None,
            },
            repository_url: None,
            permissions: MiniAppPermissions::default(),
            i18n: None,
        };
        let now = Utc::now().timestamp();
        let initial_submission_id = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO submissions(
                id, owner_user_id, slug, release_number, metadata_json, status,
                package_sha256, package_size, submitted_at, created_at, updated_at
             ) VALUES(?, ?, ?, 1, ?, 'submitted', ?, 128, ?, ?, ?)",
        )
        .bind(&initial_submission_id)
        .bind(original_owner.internal_id)
        .bind("owner-preserving-app")
        .bind(canonical_metadata_json(&metadata).unwrap())
        .bind("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        .bind(now)
        .bind(now)
        .bind(now)
        .execute(db.pool())
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO screenshots(
                id, submission_id, position, sha256, media_type, size_bytes,
                width, height, created_at
             ) VALUES(?, ?, 0, ?, 'image/webp', 64, 1600, 900, ?)",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(&initial_submission_id)
        .bind("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
        .bind(now)
        .execute(db.pool())
        .await
        .unwrap();
        approve_submission(state.as_ref(), &administrator, &initial_submission_id)
            .await
            .unwrap();

        let initial_detail = listing_detail_by_slug(state.as_ref(), "owner-preserving-app", -1)
            .await
            .unwrap();
        let listing_id = initial_detail.summary.listing_id.clone();
        assert_eq!(initial_detail.summary.owner.login, "original-owner");
        assert_eq!(
            validate_listing_ownership_and_release(
                state.as_ref(),
                &administrator,
                Some(&listing_id),
                "owner-preserving-app",
                2,
            )
            .await
            .unwrap(),
            Some(listing_id.clone()),
        );
        assert_eq!(
            validate_listing_ownership_and_release(
                state.as_ref(),
                &unrelated_user,
                Some(&listing_id),
                "owner-preserving-app",
                2,
            )
            .await
            .unwrap_err()
            .status,
            StatusCode::FORBIDDEN,
        );

        let update_submission_id = Uuid::new_v4().to_string();
        let mut update_metadata = metadata;
        update_metadata.changelog = "Administrator-published artwork refresh.".to_string();
        sqlx::query(
            "INSERT INTO submissions(
                id, listing_id, owner_user_id, slug, release_number, metadata_json, status,
                package_sha256, package_size, submitted_at, created_at, updated_at
             ) VALUES(?, ?, ?, ?, 2, ?, 'submitted', ?, 128, ?, ?, ?)",
        )
        .bind(&update_submission_id)
        .bind(&listing_id)
        .bind(administrator.internal_id)
        .bind("owner-preserving-app")
        .bind(canonical_metadata_json(&update_metadata).unwrap())
        .bind("cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc")
        .bind(now + 1)
        .bind(now + 1)
        .bind(now + 1)
        .execute(db.pool())
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO screenshots(
                id, submission_id, position, sha256, media_type, size_bytes,
                width, height, created_at
             ) VALUES(?, ?, 0, ?, 'image/webp', 64, 1600, 900, ?)",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(&update_submission_id)
        .bind("dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd")
        .bind(now + 1)
        .execute(db.pool())
        .await
        .unwrap();
        approve_submission(state.as_ref(), &administrator, &update_submission_id)
            .await
            .unwrap();

        let updated_detail = listing_detail_by_slug(state.as_ref(), "owner-preserving-app", -1)
            .await
            .unwrap();
        assert_eq!(updated_detail.summary.latest_release, 2);
        assert_eq!(updated_detail.summary.owner.login, "original-owner");
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT owner_user_id FROM listings WHERE id = ?")
                .bind(&listing_id)
                .fetch_one(db.pool())
                .await
                .unwrap(),
            original_owner.internal_id,
        );
    }

    #[tokio::test]
    async fn email_owner_can_upload_submit_and_publish_with_public_email() {
        use std::io::{Cursor, Write};
        let temporary = tempfile::tempdir().unwrap();
        let config = MarketConfig {
            bind: "127.0.0.1:0".parse().unwrap(),
            public_base_url: "https://market.openbitfun.com/miniapp".to_string(),
            database_path: temporary.path().join("market.sqlite"),
            artifact_dir: temporary.path().join("artifacts"),
            web_dir: temporary.path().join("web"),
            github_callback_url: None,
            github_client_id: Some("client-id".to_string()),
            github_client_secret: Some("client-secret".to_string()),
            session_secret: "test-session-secret-at-least-24".to_string(),
            admin_github_ids: HashSet::from([24753352]),
            public_browse: true,
            web_submissions_enabled: false,
        };
        let db = Database::open(&config.database_path).await.unwrap();
        let artifacts = ArtifactStore::open(config.artifact_dir.clone())
            .await
            .unwrap();
        let auth = AuthService::new(config.clone(), db.clone()).unwrap();
        let state = Arc::new(MarketState {
            config,
            db: db.clone(),
            artifacts,
            auth,
        });

        let owner_id = sqlx::query("INSERT INTO users(github_id, login, avatar_url, created_at, updated_at) VALUES(NULL, 'user-legacy', '', 0, 0)")
            .execute(db.pool()).await.unwrap().last_insert_rowid();
        sqlx::query("INSERT INTO email_identities(email, user_id, verified_at) VALUES('author@example.com', ?, 0)")
            .bind(owner_id).execute(db.pool()).await.unwrap();
        db.create_api_token(
            owner_id,
            "email-token",
            "access",
            "email-family",
            (Utc::now() + chrono::Duration::hours(1)).timestamp(),
        )
        .await
        .unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer email-token"),
        );
        let draft = serde_json::from_value(serde_json::json!({
            "slug":"email-owner-app", "releaseNumber":1, "name":"Email App",
            "description":"A safe email account submission.", "icon":"box", "category":"developer",
            "tags":["test"], "minOpenBitFunVersion":"1.0.0", "changelog":"Initial release",
            "license":{"spdxExpression":"MIT"}
        }))
        .unwrap();
        let submission = create_submission(State(state.clone()), headers.clone(), Json(draft))
            .await
            .unwrap()
            .0;
        let id = submission.submission_id;
        let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (path, content) in [
            (
                "meta.json",
                r#"{"name":"Email App","description":"Safe test app","icon":"box","category":"developer","tags":[],"version":1,"permissions":{"node":{"enabled":false}}}"#,
            ),
            ("source/index.html", "<html><body>Test</body></html>"),
            ("source/style.css", "body { margin: 0; }"),
            ("source/ui.js", "document.body.dataset.ready = '1';"),
            ("source/worker.js", "module.exports = {};"),
            ("source/esm_dependencies.json", "[]"),
        ] {
            archive
                .start_file(path, zip::write::SimpleFileOptions::default())
                .unwrap();
            archive.write_all(content.as_bytes()).unwrap();
        }
        let package = archive.finish().unwrap().into_inner();
        upload_submission_package(
            State(state.clone()),
            headers.clone(),
            Path(id.clone()),
            Bytes::from(package),
        )
        .await
        .unwrap();
        let mut screenshot = Cursor::new(Vec::new());
        image::DynamicImage::new_rgba8(800, 400)
            .write_to(&mut screenshot, image::ImageFormat::Png)
            .unwrap();
        upload_submission_screenshot(
            State(state.clone()),
            headers.clone(),
            Path((id.clone(), 0)),
            Bytes::from(screenshot.into_inner()),
        )
        .await
        .unwrap();
        let submitted = submit_submission(State(state.clone()), headers.clone(), Path(id.clone()))
            .await
            .unwrap()
            .0;
        assert_eq!(submitted.status, MarketSubmissionStatus::Submitted);
        let review = admin_submission_by_id(state.as_ref(), &id).await.unwrap();
        assert_eq!(review.submitter.login, "author@example.com");
        assert_eq!(review.submitter.github_id, 0);
        let admin = db.upsert_github_user(24753352, "admin", "").await.unwrap();
        approve_submission(state.as_ref(), &admin, &id)
            .await
            .unwrap();
        let detail = listing_detail_by_slug(state.as_ref(), "email-owner-app", owner_id)
            .await
            .unwrap();
        assert_eq!(detail.summary.owner.login, "author@example.com");
        assert_eq!(detail.summary.owner.github_id, 0);
        use tower::ServiceExt;
        let downloaded = api_router(state.clone())
            .oneshot(
                Request::builder()
                    .uri("/listings/email-owner-app/releases/1/download")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(downloaded.status(), StatusCode::OK);
        let authenticated = state.auth.require_auth(&headers).await.unwrap();
        assert!(!state.auth.is_admin(&authenticated.user));
        assert_eq!(
            validate_listing_ownership_and_release(
                state.as_ref(),
                &authenticated.user,
                Some(&detail.summary.listing_id),
                "email-owner-app",
                2
            )
            .await
            .unwrap(),
            Some(detail.summary.listing_id)
        );
    }

    #[test]
    fn submission_write_policy_excludes_reads_and_admin_review_routes() {
        assert!(is_submission_write_request(&Method::POST, "/submissions"));
        assert!(is_submission_write_request(
            &Method::PUT,
            "/submissions/submission-id/package"
        ));
        assert!(is_submission_write_request(
            &Method::DELETE,
            "/miniapp/api/v1/submissions/submission-id/screenshots/0"
        ));
        assert!(!is_submission_write_request(&Method::GET, "/submissions"));
        assert!(!is_submission_write_request(
            &Method::POST,
            "/admin/submissions/submission-id/decision"
        ));
        assert!(!is_submission_write_request(
            &Method::PUT,
            "/listings/example/favorite"
        ));
    }

    #[tokio::test]
    async fn disabled_web_submission_writes_are_rejected_before_body_parsing() {
        use tower::ServiceExt;

        let temporary = tempfile::tempdir().unwrap();
        let config = MarketConfig {
            bind: "127.0.0.1:0".parse().unwrap(),
            public_base_url: "https://market.openbitfun.com/miniapp".to_string(),
            database_path: temporary.path().join("market.sqlite"),
            artifact_dir: temporary.path().join("artifacts"),
            web_dir: temporary.path().join("web"),
            github_callback_url: None,
            github_client_id: Some("client-id".to_string()),
            github_client_secret: Some("client-secret".to_string()),
            session_secret: "test-session-secret-at-least-24".to_string(),
            admin_github_ids: HashSet::from([24753352]),
            public_browse: true,
            web_submissions_enabled: false,
        };
        let db = Database::open(&config.database_path).await.unwrap();
        let artifacts = ArtifactStore::open(config.artifact_dir.clone())
            .await
            .unwrap();
        let auth = AuthService::new(config.clone(), db.clone()).unwrap();
        let user = db
            .upsert_github_user(
                24753352,
                "bobleer",
                "https://avatars.githubusercontent.com/u/24753352",
            )
            .await
            .unwrap();
        db.create_web_session(
            user.internal_id,
            "web-session-token",
            "csrf-token",
            (Utc::now() + chrono::Duration::hours(1)).timestamp(),
        )
        .await
        .unwrap();
        db.create_api_token(
            user.internal_id,
            "desktop-access-token",
            "access",
            "desktop-token-family",
            (Utc::now() + chrono::Duration::hours(1)).timestamp(),
        )
        .await
        .unwrap();
        let state = Arc::new(MarketState {
            config,
            db,
            artifacts,
            auth,
        });
        let app = api_router(state.clone());
        let cookie =
            "openbitfun_market_session=web-session-token; openbitfun_market_csrf=csrf-token";

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/submissions")
                    .header(header::COOKIE, cookie)
                    .header("x-csrf-token", "csrf-token")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from("not valid json"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let body = axum::body::to_bytes(response.into_body(), 8 * 1024)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["error"]["code"], "web_submissions_disabled");

        let history = app
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/submissions")
                    .header(header::COOKIE, cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(history.status(), StatusCode::OK);

        let mut desktop_headers = HeaderMap::new();
        desktop_headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer desktop-access-token"),
        );
        let desktop_auth = require_submission_write_auth(&state, &desktop_headers)
            .await
            .unwrap();
        assert!(matches!(desktop_auth.kind, RequestAuthKind::Bearer { .. }));
    }
}

async fn start_web_login(
    State(state): State<Arc<MarketState>>,
    Json(query): Json<OAuthStartQuery>,
) -> MarketResult<Json<serde_json::Value>> {
    let ticket = state
        .auth
        .start_web_login(query.return_to.as_deref().unwrap_or("/miniapp/"))
        .await?;
    Ok(Json(
        serde_json::json!({"ticket": ticket, "emailEnabled": state.auth.mailer.is_some(), "githubEnabled": state.config.github_configured()}),
    ))
}
async fn login_github(
    State(state): State<Arc<MarketState>>,
    Json(request): Json<crate::email_auth::LoginRequest>,
) -> MarketResult<Json<serde_json::Value>> {
    Ok(Json(
        serde_json::json!({"authorizationUrl": state.auth.login_github(&request.ticket).await?}),
    ))
}
async fn send_email_code(
    State(state): State<Arc<MarketState>>,
    Json(request): Json<crate::email_auth::EmailSendRequest>,
) -> MarketResult<Json<crate::email_auth::EmailSent>> {
    Ok(Json(state.auth.send_email_code(request).await?))
}
async fn verify_email_code(
    State(state): State<Arc<MarketState>>,
    Json(request): Json<crate::email_auth::EmailVerifyRequest>,
) -> MarketResult<Response> {
    let completed = state.auth.verify_email_code(request).await?;
    // Establish market host-only cookies through a short-lived, one-use grant,
    // just as the GitHub callback is bridged to the market origin by Nginx.
    let redirect_url = state.auth.email_browser_redirect(completed).await?;
    Ok(Json(serde_json::json!({"redirectUrl": redirect_url})).into_response())
}

#[derive(Deserialize)]
struct EmailBrowserGrant {
    grant: String,
}
async fn complete_email_browser(
    State(state): State<Arc<MarketState>>,
    Query(query): Query<EmailBrowserGrant>,
) -> MarketResult<Response> {
    let completed = state.auth.complete_email_browser(&query.grant).await?;
    complete_login_response(&state, completed, false)
}
