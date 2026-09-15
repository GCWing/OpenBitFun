use anyhow::{anyhow, Result};
use log::warn;
use reqwest::{
    header::{HeaderMap, RETRY_AFTER},
    RequestBuilder, StatusCode,
};
use serde::de::DeserializeOwned;
use std::{
    error::Error as StdError,
    sync::OnceLock,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const RELAY_HTTP_TIMEOUT: Duration = Duration::from_secs(120);
const RELAY_HTTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const RELAY_HTTP_READ_TIMEOUT: Duration = Duration::from_secs(30);
const RELAY_HTTP_RETRY_BUDGET: Duration = Duration::from_secs(120);
const MAX_RETRY_AFTER: Duration = Duration::from_secs(5);

static RELAY_HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

/// Retry classes are intentionally narrow. Callers must opt in only when the
/// same request can be replayed without duplicating a user-visible action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RelayHttpRetry {
    /// Compatibility path for an operation that an older relay cannot dedupe.
    SingleAttempt,
    /// GET-like reads and challenge probes that do not mutate relay state.
    SafeRead,
    /// Writes with a stable final state or a relay-persisted idempotency key.
    IdempotentWrite,
}

impl RelayHttpRetry {
    const fn max_attempts(self) -> usize {
        match self {
            Self::SingleAttempt => 1,
            Self::SafeRead => 5,
            Self::IdempotentWrite => 5,
        }
    }
}

pub(crate) struct BufferedRelayResponse {
    status: StatusCode,
    body: Vec<u8>,
}

impl BufferedRelayResponse {
    pub(crate) fn status(&self) -> StatusCode {
        self.status
    }

    pub(crate) async fn json<T: DeserializeOwned>(self) -> Result<T> {
        serde_json::from_slice(&self.body)
            .map_err(|error| anyhow!("decode relay JSON response: {error}"))
    }

    pub(crate) async fn text(self) -> Result<String> {
        Ok(String::from_utf8_lossy(&self.body).into_owned())
    }

    pub(crate) fn into_parts(self) -> (StatusCode, Vec<u8>) {
        (self.status, self.body)
    }
}

/// Reuse one reqwest pool across account, sync, and Page management calls.
/// Rebuilding a client for every poll forces a fresh proxy CONNECT + TLS
/// handshake and makes short proxy/node disturbances much more visible.
pub(crate) fn relay_http_client() -> reqwest::Client {
    RELAY_HTTP_CLIENT
        .get_or_init(|| {
            crate::reqwest_client_builder()
                .timeout(RELAY_HTTP_TIMEOUT)
                .connect_timeout(RELAY_HTTP_CONNECT_TIMEOUT)
                .read_timeout(RELAY_HTTP_READ_TIMEOUT)
                .pool_idle_timeout(Duration::from_secs(90))
                .build()
                .unwrap_or_else(|error| {
                    warn!(
                        "Failed to build shared relay HTTP client; using reqwest defaults: {error}"
                    );
                    crate::reqwest_client()
                })
        })
        .clone()
}

pub(crate) async fn send_with_retry(
    operation: &'static str,
    request: RequestBuilder,
    policy: RelayHttpRetry,
) -> Result<BufferedRelayResponse> {
    tokio::time::timeout(
        RELAY_HTTP_RETRY_BUDGET,
        send_with_retry_within_budget(operation, request, policy),
    )
    .await
    .map_err(|_| {
        anyhow!(
            "relay HTTP {operation} exceeded the {}s total retry budget",
            RELAY_HTTP_RETRY_BUDGET.as_secs()
        )
    })?
}

async fn send_with_retry_within_budget(
    operation: &'static str,
    request: RequestBuilder,
    policy: RelayHttpRetry,
) -> Result<BufferedRelayResponse> {
    let max_attempts = policy.max_attempts();
    for attempt in 1..=max_attempts {
        let request = request.try_clone().ok_or_else(|| {
            anyhow!("relay HTTP {operation} request body cannot be replayed safely")
        })?;

        match request.send().await {
            Ok(response) if is_transient_status(response.status()) && attempt < max_attempts => {
                let status = response.status();
                let delay = retry_delay(attempt, Some(response.headers()));
                warn!(
                    "Relay HTTP request will retry: operation={operation} \
                     attempt={attempt}/{max_attempts} status={status} delay_ms={}",
                    delay.as_millis()
                );
                drop(response);
                tokio::time::sleep(delay).await;
            }
            Ok(response) => {
                let status = response.status();
                match response.bytes().await {
                    Ok(body) => {
                        return Ok(BufferedRelayResponse {
                            status,
                            body: body.to_vec(),
                        });
                    }
                    Err(error)
                        if is_retryable_transport_error(&error) && attempt < max_attempts =>
                    {
                        // Once a definitive non-retryable HTTP status arrives,
                        // replaying a write just to recover its error body can
                        // repeat authentication/validation side effects.
                        if !status.is_success() && !is_transient_status(status) {
                            return Ok(BufferedRelayResponse {
                                status,
                                body: Vec::new(),
                            });
                        }
                        let delay = retry_delay(attempt, None);
                        warn!(
                            "Relay HTTP response body will retry: operation={operation} \
                             attempt={attempt}/{max_attempts} delay_ms={} error={}",
                            delay.as_millis(),
                            reqwest_error_summary(&error)
                        );
                        tokio::time::sleep(delay).await;
                    }
                    Err(error) => {
                        return Err(anyhow!(
                            "relay HTTP {operation} response body failed after {attempt} attempt(s): {}",
                            reqwest_error_summary(&error)
                        ));
                    }
                }
            }
            Err(error) if is_retryable_transport_error(&error) && attempt < max_attempts => {
                let delay = retry_delay(attempt, None);
                warn!(
                    "Relay HTTP request will retry: operation={operation} \
                     attempt={attempt}/{max_attempts} delay_ms={} error={}",
                    delay.as_millis(),
                    reqwest_error_summary(&error)
                );
                tokio::time::sleep(delay).await;
            }
            Err(error) => {
                return Err(anyhow!(
                    "relay HTTP {operation} failed after {attempt} attempt(s): {}",
                    reqwest_error_summary(&error)
                ));
            }
        }
    }

    unreachable!("relay HTTP retry loop always returns")
}

fn is_transient_status(status: StatusCode) -> bool {
    matches!(
        status,
        StatusCode::REQUEST_TIMEOUT
            | StatusCode::TOO_EARLY
            | StatusCode::INTERNAL_SERVER_ERROR
            | StatusCode::BAD_GATEWAY
            | StatusCode::SERVICE_UNAVAILABLE
            | StatusCode::GATEWAY_TIMEOUT
    )
}

fn is_retryable_transport_error(error: &reqwest::Error) -> bool {
    error.is_connect() || error.is_timeout() || error.is_body() || error.is_decode()
}

fn retry_delay(attempt: usize, headers: Option<&HeaderMap>) -> Duration {
    if let Some(delay) = headers
        .and_then(|headers| headers.get(RETRY_AFTER))
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .map(Duration::from_secs)
    {
        return delay.min(MAX_RETRY_AFTER);
    }

    let exponent = attempt.saturating_sub(1).min(4) as u32;
    let base_ms = 300u64.saturating_mul(2u64.pow(exponent));
    // Small local jitter prevents many clients from retrying a recovered relay
    // or proxy at exactly the same instant without adding another dependency.
    let jitter_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| u64::from(duration.subsec_nanos()) % 151)
        .unwrap_or_default();
    Duration::from_millis(base_ms + jitter_ms)
}

fn reqwest_error_summary(error: &reqwest::Error) -> String {
    let mut details = vec![format!(
        "{} [connect={}, timeout={}, body={}, decode={}]",
        error,
        error.is_connect(),
        error.is_timeout(),
        error.is_body(),
        error.is_decode()
    )];
    let mut source = error.source();
    for _ in 0..4 {
        let Some(cause) = source else {
            break;
        };
        let cause_text = cause.to_string();
        if !details.iter().any(|detail| detail == &cause_text) {
            details.push(cause_text);
        }
        source = cause.source();
    }
    details.join("; caused by: ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    #[test]
    fn retries_only_transient_http_statuses() {
        assert_eq!(RelayHttpRetry::SingleAttempt.max_attempts(), 1);
        assert_eq!(RelayHttpRetry::SafeRead.max_attempts(), 5);
        assert_eq!(RelayHttpRetry::IdempotentWrite.max_attempts(), 5);
        for status in [
            StatusCode::REQUEST_TIMEOUT,
            StatusCode::TOO_EARLY,
            StatusCode::INTERNAL_SERVER_ERROR,
            StatusCode::BAD_GATEWAY,
            StatusCode::SERVICE_UNAVAILABLE,
            StatusCode::GATEWAY_TIMEOUT,
        ] {
            assert!(is_transient_status(status), "{status} should be transient");
        }
        for status in [
            StatusCode::BAD_REQUEST,
            StatusCode::UNAUTHORIZED,
            StatusCode::NOT_FOUND,
            StatusCode::CONFLICT,
            StatusCode::TOO_MANY_REQUESTS,
            StatusCode::PAYLOAD_TOO_LARGE,
        ] {
            assert!(!is_transient_status(status), "{status} must not be retried");
        }
    }

    #[test]
    fn retry_after_is_bounded() {
        let mut headers = HeaderMap::new();
        headers.insert(RETRY_AFTER, "60".parse().unwrap());
        assert_eq!(retry_delay(1, Some(&headers)), MAX_RETRY_AFTER);
    }

    #[tokio::test]
    async fn safe_read_retries_a_transient_response() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let attempts = Arc::new(AtomicUsize::new(0));
        let server_attempts = attempts.clone();
        let server = tokio::spawn(async move {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = vec![0u8; 2048];
                let _ = stream.read(&mut request).await.unwrap();
                let attempt = server_attempts.fetch_add(1, Ordering::SeqCst);
                let response = if attempt == 0 {
                    "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                } else {
                    "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"
                };
                stream.write_all(response.as_bytes()).await.unwrap();
            }
        });
        let client = crate::reqwest_client_builder().no_proxy().build().unwrap();

        let response = send_with_retry(
            "test-safe-read",
            client.get(format!("http://{address}/health")),
            RelayHttpRetry::SafeRead,
        )
        .await
        .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn safe_read_retries_a_truncated_response_body() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let attempts = Arc::new(AtomicUsize::new(0));
        let server_attempts = attempts.clone();
        let server = tokio::spawn(async move {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = vec![0u8; 2048];
                let _ = stream.read(&mut request).await.unwrap();
                let attempt = server_attempts.fetch_add(1, Ordering::SeqCst);
                let response = if attempt == 0 {
                    "HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\nshort"
                } else {
                    "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"
                };
                stream.write_all(response.as_bytes()).await.unwrap();
            }
        });
        let client = crate::reqwest_client_builder().no_proxy().build().unwrap();

        let response = send_with_retry(
            "test-truncated-body",
            client.get(format!("http://{address}/health")),
            RelayHttpRetry::SafeRead,
        )
        .await
        .unwrap();

        assert_eq!(response.text().await.unwrap(), "ok");
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn non_retryable_status_does_not_replay_for_a_truncated_error_body() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let attempts = Arc::new(AtomicUsize::new(0));
        let server_attempts = attempts.clone();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = vec![0u8; 2048];
            let _ = stream.read(&mut request).await.unwrap();
            server_attempts.fetch_add(1, Ordering::SeqCst);
            stream
                .write_all(
                    b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 10\r\nConnection: close\r\n\r\nshort",
                )
                .await
                .unwrap();
        });
        let client = crate::reqwest_client_builder().no_proxy().build().unwrap();

        let response = send_with_retry(
            "test-truncated-error-body",
            client.post(format!("http://{address}/login")),
            RelayHttpRetry::IdempotentWrite,
        )
        .await
        .unwrap();

        let (status, body) = response.into_parts();
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert!(body.is_empty());
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
        server.await.unwrap();
    }
}
