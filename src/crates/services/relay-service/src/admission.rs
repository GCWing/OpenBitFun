//! Admission happens before JSON/body buffering and expensive identity calls.
use crate::routes::api::AppState;
use axum::{
    extract::{ConnectInfo, Request, State},
    http::{header, Method, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use std::{
    net::SocketAddr,
    sync::{Arc, OnceLock},
    time::Duration,
};
use tokio::sync::Semaphore;

const BODY_MEMORY_BUDGET: usize = 512 * 1024 * 1024;
const MAX_REQUESTS: usize = 2048;
const MAX_API_BODY: usize = 48 * 1024 * 1024 + 64 * 1024;

pub(crate) async fn admit(
    State(state): State<AppState>,
    mut request: Request,
    next: Next,
) -> Response {
    let path = request.uri().path();
    // Relay-stored session history is retired. Answer before authentication or
    // body buffering: an older host retrying a multi-megabyte upload costs the
    // relay nothing, and the reason is explicit rather than a quota error.
    if crate::realtime::retired_session_history::is_retired_path(path) {
        return crate::realtime::retired_session_history::gone_response();
    }
    if !path.starts_with("/api/") {
        return next.run(request).await;
    }
    let peer = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|peer| peer.0);
    let ip = crate::routes::auth::client_ip(request.headers(), peer);
    if !state
        .login_rate_limiter
        .check_and_record("http", &ip, 6000, None)
    {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    if path.starts_with("/api/devices") {
        let auth = match crate::routes::devices::validate_user(&state, request.headers()).await {
            Ok(auth) => auth,
            Err(status) => return status.into_response(),
        };
        if !state
            .login_rate_limiter
            .check_and_record("account-http", &auth.user_id, 6000, None)
        {
            return StatusCode::TOO_MANY_REQUESTS.into_response();
        }
    }
    static REQUESTS: OnceLock<Arc<Semaphore>> = OnceLock::new();
    static MEMORY: OnceLock<Arc<Semaphore>> = OnceLock::new();
    let Ok(request_slot) =
        Arc::clone(REQUESTS.get_or_init(|| Arc::new(Semaphore::new(MAX_REQUESTS))))
            .try_acquire_owned()
    else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let mut memory_permit = None;
    if request.method() == Method::POST {
        let maximum = if path.starts_with("/api/auth/") {
            16 * 1024
        } else {
            MAX_API_BODY
        };
        let declared = request
            .headers()
            .get(header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<usize>().ok());
        if declared.is_some_and(|length| length > maximum) {
            return StatusCode::PAYLOAD_TOO_LARGE.into_response();
        }
        let reservation = declared.unwrap_or(maximum).max(64 * 1024);
        memory_permit =
            match Arc::clone(MEMORY.get_or_init(|| Arc::new(Semaphore::new(BODY_MEMORY_BUDGET))))
                .try_acquire_many_owned(reservation as u32)
            {
                Ok(permit) => Some(permit),
                Err(_) => return StatusCode::SERVICE_UNAVAILABLE.into_response(),
            };
        let body = std::mem::replace(request.body_mut(), axum::body::Body::empty());
        let bytes = match tokio::time::timeout(
            Duration::from_secs(15),
            axum::body::to_bytes(body, declared.unwrap_or(maximum).min(maximum)),
        )
        .await
        {
            Ok(Ok(bytes)) => bytes,
            Ok(Err(_)) => return StatusCode::PAYLOAD_TOO_LARGE.into_response(),
            Err(_) => return StatusCode::REQUEST_TIMEOUT.into_response(),
        };
        // Unknown-length ingress reserves its ceiling before reading. Once
        // buffered, retain only the actual body reservation through the reply.
        if let Some(permit) = memory_permit.as_mut() {
            let unused = permit
                .num_permits()
                .saturating_sub(bytes.len().max(64 * 1024));
            drop(permit.split(unused));
        }
        *request.body_mut() = axum::body::Body::from(bytes);
    }
    let result = tokio::time::timeout(Duration::from_secs(130), next.run(request)).await;
    let response = result.unwrap_or_else(|_| StatusCode::REQUEST_TIMEOUT.into_response());
    let (parts, body) = response.into_parts();
    let stream = futures_util::stream::unfold(
        (body.into_data_stream(), request_slot, memory_permit),
        |(mut body, request_slot, memory_permit)| async move {
            use futures_util::StreamExt;
            body.next()
                .await
                .map(|chunk| (chunk, (body, request_slot, memory_permit)))
        },
    );
    Response::from_parts(parts, axum::body::Body::from_stream(stream))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use tower::ServiceExt;

    async fn router() -> axum::Router {
        let db = crate::db::connect(":memory:").await.unwrap();
        crate::build_relay_router(
            Arc::new(crate::MemoryAssetStore::new()),
            std::time::Instant::now(),
            Arc::new(db),
            "test",
        )
    }

    #[tokio::test]
    async fn unauthenticated_rpc_is_rejected_before_reading_unbounded_body() {
        let body = Body::from_stream(futures_util::stream::pending::<
            Result<axum::body::Bytes, std::io::Error>,
        >());
        let request = Request::builder()
            .method("POST")
            .uri("/v1/rpc/payloads")
            .body(body)
            .unwrap();
        let response =
            tokio::time::timeout(Duration::from_secs(1), router().await.oneshot(request))
                .await
                .unwrap()
                .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(response.headers().get("cache-control").unwrap(), "no-store");
    }

    #[tokio::test]
    async fn retired_history_routes_are_answered_before_reading_unbounded_body() {
        for path in ["/v1/sessions", "/v3/sessions/session/messages"] {
            let body = Body::from_stream(futures_util::stream::pending::<
                Result<axum::body::Bytes, std::io::Error>,
            >());
            let request = Request::builder()
                .method("POST")
                .uri(path)
                .body(body)
                .unwrap();
            let response =
                tokio::time::timeout(Duration::from_secs(1), router().await.oneshot(request))
                    .await
                    .unwrap()
                    .unwrap();
            assert_eq!(response.status(), StatusCode::GONE);
            assert_eq!(response.headers().get("cache-control").unwrap(), "no-store");
        }
    }

    #[tokio::test]
    async fn chunked_oversize_auth_body_is_rejected() {
        let request = Request::builder()
            .method("POST")
            .uri("/api/auth/login")
            .header("content-type", "application/json")
            .body(Body::from("x".repeat(16385)))
            .unwrap();
        let response = router().await.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[tokio::test]
    async fn account_service_does_not_expose_anonymous_rooms() {
        let request = Request::builder()
            .method("POST")
            .uri("/api/rooms/test/pair")
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            router().await.oneshot(request).await.unwrap().status(),
            StatusCode::NOT_FOUND
        );
    }
}
