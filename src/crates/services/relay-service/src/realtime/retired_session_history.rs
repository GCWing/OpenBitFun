//! Retirement answers for the relay-stored session history of earlier releases.
//!
//! The relay forwards ciphertext between online devices and keeps no session
//! content. Hosts and controllers built before this change still call the
//! `/v1/sessions` and `/v3/sessions/{id}/messages` routes; they receive an
//! explicit `410 Gone` with a machine-readable reason instead of a silent
//! failure, and never a fake success that would make them believe content was
//! stored or read.
use axum::{
    http::{header, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::json;

pub(crate) const ERROR_CODE: &str = "relay_session_history_retired";
pub(crate) const MESSAGE: &str = "This relay does not store session history. Session records are read from the online host on demand; update OpenBitFun on every device to continue.";
pub(crate) const HANDSHAKE_MESSAGE: &str =
    "session-scoped realtime and relay-stored session metadata have been retired";

/// Whether a request path belongs to the retired history API.
pub(crate) fn is_retired_path(path: &str) -> bool {
    path == "/v1/sessions" || path.starts_with("/v1/sessions/") || path.starts_with("/v3/sessions/")
}

/// `410 Gone` with a JSON body; usable both as a route handler and directly
/// from admission, where it answers before any request body is buffered.
pub(crate) async fn gone() -> Response {
    gone_response()
}

pub(crate) fn gone_response() -> Response {
    (
        StatusCode::GONE,
        [(header::CONTENT_TYPE, "application/json")],
        json!({"error": ERROR_CODE, "message": MESSAGE}).to_string(),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{to_bytes, Body};
    use axum::http::Request;
    use std::sync::Arc;
    use tower::ServiceExt;

    #[test]
    fn retired_paths_cover_every_history_route_of_earlier_releases() {
        assert!(is_retired_path("/v1/sessions"));
        assert!(is_retired_path("/v1/sessions/abc"));
        assert!(is_retired_path("/v3/sessions/abc/messages"));
        assert!(!is_retired_path("/v1/updates"));
        assert!(!is_retired_path("/v1/rpc/payloads"));
        assert!(!is_retired_path("/api/devices"));
    }

    #[tokio::test]
    async fn history_routes_answer_gone_without_authentication_or_body_reads() {
        let app = crate::build_relay_router(
            Arc::new(crate::MemoryAssetStore::new()),
            std::time::Instant::now(),
            Arc::new(crate::db::connect(":memory:").await.unwrap()),
            "test",
        );
        let requests = [
            (
                "POST",
                "/v1/sessions",
                Some(r#"{"id":"s","metadata":"{}"}"#),
            ),
            ("GET", "/v1/sessions/s", None),
            ("GET", "/v3/sessions/s/messages?after_seq=0", None),
            (
                "POST",
                "/v3/sessions/s/messages",
                Some(r#"{"messages":[]}"#),
            ),
        ];
        for (method, uri, body) in requests {
            let mut builder = Request::builder().method(method).uri(uri);
            if body.is_some() {
                builder = builder.header("content-type", "application/json");
            }
            let request = builder
                .body(body.map(Body::from).unwrap_or_else(Body::empty))
                .unwrap();
            let response = app.clone().oneshot(request).await.unwrap();
            assert_eq!(response.status(), StatusCode::GONE, "{method} {uri}");
            let value: serde_json::Value =
                serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap())
                    .unwrap();
            assert_eq!(value["error"], ERROR_CODE);
            assert_eq!(value["message"], MESSAGE);
        }
    }

    #[tokio::test]
    async fn oversized_legacy_uploads_are_refused_before_buffering() {
        let app = crate::build_relay_router(
            Arc::new(crate::MemoryAssetStore::new()),
            std::time::Instant::now(),
            Arc::new(crate::db::connect(":memory:").await.unwrap()),
            "test",
        );
        // A declared multi-megabyte body must not be read into memory just to
        // be told the route is gone.
        let request = Request::builder()
            .method("POST")
            .uri("/v3/sessions/s/messages")
            .header("content-type", "application/json")
            .header("content-length", (64 * 1024 * 1024).to_string())
            .body(Body::from(vec![b'x'; 16]))
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::GONE);
    }
}
