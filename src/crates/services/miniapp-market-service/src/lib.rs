//! OpenBitFun MiniApp marketplace service.

mod artifacts;
mod auth;
mod auth_admission;
pub mod config;
mod db;
mod email_auth;
mod error;
mod package;
mod request_id;
mod retention;
mod routes;

use artifacts::ArtifactStore;
use auth::AuthService;
use axum::extract::Request;
use axum::http::{header, HeaderValue, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::get;
use axum::Router;
use config::MarketConfig;
use db::Database;
use routes::{api_router, MarketState};
use std::sync::Arc;
use tower_http::services::{ServeDir, ServeFile};

pub use error::{MarketError, MarketResult};
pub use package::{
    validate_market_package, validate_min_openbitfun_version, validate_screenshot,
    ValidatedMarketPackage, ValidatedScreenshot,
};

pub async fn build_market_router(config: MarketConfig) -> anyhow::Result<Router> {
    let db = Database::open(&config.database_path).await?;
    let artifacts = ArtifactStore::open(config.artifact_dir.clone()).await?;
    let cleanup = retention::cleanup_expired_submission_artifacts(&db, &artifacts).await?;
    if cleanup.submissions_scrubbed > 0
        || cleanup.packages_removed > 0
        || cleanup.screenshots_removed > 0
    {
        tracing::info!(
            submissions_scrubbed = cleanup.submissions_scrubbed,
            packages_removed = cleanup.packages_removed,
            screenshots_removed = cleanup.screenshots_removed,
            "MiniApp market startup retention cleanup completed"
        );
    }
    retention::spawn_cleanup_loop(db.clone(), artifacts.clone());
    let auth_cleanup_db = db.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(300));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        interval.tick().await;
        loop {
            interval.tick().await;
            if let Err(error) = auth_cleanup_db.cleanup_expired_auth().await {
                tracing::error!(%error, "Global identity authorization cleanup failed");
            }
        }
    });
    let auth = AuthService::new(config.clone(), db.clone())
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let state = Arc::new(MarketState {
        config: config.clone(),
        db,
        artifacts,
        auth,
    });

    let index_file = config.web_dir.join("index.html");
    let spa = ServeDir::new(&config.web_dir)
        .append_index_html_on_directories(true)
        .fallback(ServeFile::new(index_file));

    Ok(Router::new()
        .route("/", get(|| async { Redirect::permanent("/miniapp/") }))
        .nest("/miniapp/api/v1", api_router(state))
        .nest_service("/miniapp", spa)
        .layer(axum::middleware::from_fn(normalize_payload_too_large))
        .layer(axum::middleware::from_fn(security_headers))
        .layer(axum::middleware::from_fn(request_id::middleware)))
}

async fn normalize_payload_too_large(request: Request, next: Next) -> Response {
    let response = next.run(request).await;
    if response.status() == StatusCode::PAYLOAD_TOO_LARGE {
        MarketError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "payload_too_large",
            "The upload exceeds the marketplace size limit.",
        )
        .into_response()
    } else {
        response
    }
}

async fn security_headers(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    // SPA HTML selects the versioned assets, so it must never survive a deploy
    // in browser or intermediary caches. Hashed JS/CSS keep their own policy.
    if headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("text/html"))
    {
        headers.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-store, max-age=0"),
        );
        headers.insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
        headers.insert(header::EXPIRES, HeaderValue::from_static("0"));
    }
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("strict-origin-when-cross-origin"),
    );
    headers.insert(
        header::X_FRAME_OPTIONS,
        HeaderValue::from_static("SAMEORIGIN"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
             img-src 'self' data: https://avatars.githubusercontent.com; \
             connect-src 'self'; object-src 'none'; base-uri 'self'; \
             frame-ancestors 'self'; form-action 'self'",
        ),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{Body, Bytes};
    use axum::http::{header, Request, StatusCode};
    use axum::routing::post;
    use std::collections::HashSet;
    use std::io::Cursor;
    use tower::ServiceExt;

    #[tokio::test]
    async fn health_route_boots_with_an_empty_database() {
        let temp = tempfile::tempdir().unwrap();
        let config = MarketConfig {
            bind: "127.0.0.1:0".parse().unwrap(),
            public_base_url: "http://localhost/miniapp".to_string(),
            database_path: temp.path().join("market.sqlite"),
            artifact_dir: temp.path().join("artifacts"),
            web_dir: temp.path().join("web"),
            github_callback_url: None,
            github_client_id: None,
            github_client_secret: None,
            session_secret: "test-session-secret-at-least-24".to_string(),
            admin_github_ids: [24753352].into_iter().collect(),
            admin_emails: HashSet::new(),
            public_browse: true,
            web_submissions_enabled: false,
        };
        tokio::fs::create_dir_all(&config.web_dir).await.unwrap();
        tokio::fs::write(config.web_dir.join("index.html"), "<html></html>")
            .await
            .unwrap();
        let screenshot_hash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let mut screenshot = Cursor::new(Vec::new());
        image::DynamicImage::new_rgba8(800, 400)
            .write_to(&mut screenshot, image::ImageFormat::WebP)
            .unwrap();
        ArtifactStore::open(config.artifact_dir.clone())
            .await
            .unwrap()
            .put_screenshot(screenshot_hash, &screenshot.into_inner())
            .await
            .unwrap();
        let app = build_market_router(config).await.unwrap();
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/miniapp/api/v1/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        for uri in [
            "/miniapp/",
            "/miniapp/admin",
            "/miniapp/auth/sign-in",
            "/miniapp/auth/complete",
        ] {
            let response = app
                .clone()
                .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK, "{uri}");
            assert_eq!(
                response.headers()[header::CACHE_CONTROL],
                "no-store, max-age=0"
            );
        }

        // Unknown API paths must not fall through to the SPA's index.html.
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/miniapp/api/v1/auth/github/login")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let body = axum::body::to_bytes(response.into_body(), 1024)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["error"]["code"], "not_found");

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/miniapp/api/v1/screenshots/{screenshot_hash}?variant=compact-v1"
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(response.headers()[header::ETAG]
            .to_str()
            .unwrap()
            .ends_with("-compact-v1\""));
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let decoded = image::load_from_memory_with_format(&body, image::ImageFormat::WebP).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (640, 320));

        let response = app
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/miniapp/api/v1/screenshots/{screenshot_hash}?variant=unbounded"
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn body_limit_errors_use_the_versioned_error_envelope() {
        let app = Router::new()
            .route("/upload", post(|_: Bytes| async { StatusCode::NO_CONTENT }))
            .layer(axum::extract::DefaultBodyLimit::max(1))
            .layer(axum::middleware::from_fn(normalize_payload_too_large))
            .layer(axum::middleware::from_fn(request_id::middleware));
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/upload")
                    .body(Body::from("too large"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert!(response.headers().contains_key("x-request-id"));
        let body = axum::body::to_bytes(response.into_body(), 1024)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["error"]["code"], "payload_too_large");
        assert!(body["error"]["requestId"].as_str().is_some());
    }
}
