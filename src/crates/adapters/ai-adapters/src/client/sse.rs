use crate::client::request_capacity::{RequestCapacity, RequestCompletion};
use crate::client::utils::elapsed_ms_u64;
use crate::client::StreamResponse;
use crate::stream::UnifiedResponse;
use crate::trace::{ModelExchangeRequestAttempt, ModelExchangeTraceConfig};
use anyhow::{anyhow, Result};
use chrono::{DateTime, Utc};
use futures::Stream;
use log::{debug, error, warn};
use openbitfun_agent_stream::ToolCallCompletion;
use openbitfun_core_types::errors::{AiProviderError, ErrorCategory};
use reqwest::{
    header::{HeaderMap, RETRY_AFTER},
    StatusCode,
};
use std::borrow::Cow;
use std::error::Error as StdError;
use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_stream::wrappers::UnboundedReceiverStream;
use tokio_util::sync::CancellationToken;

const BASE_RETRY_DELAY_MS: u64 = 500;
/// Base delay for HTTP 429 / rate-limit retries when `Retry-After` is absent.
///
/// Providers frequently omit `Retry-After` (or send a useless 1s value). The
/// previous general backoff capped at 4s (`attempt.min(3)`), so 10 attempts
/// finished in ~90s and never waited for TPM / RPM windows to recover —
/// especially painful when multiple subagents retry in parallel.
const RATE_LIMIT_BASE_RETRY_DELAY_MS: u64 = 2_000;
/// Cap for the general (non-429) exponential backoff ladder.
const MAX_EXPONENTIAL_DELAY_MS: u64 = 30_000;
/// Maximum exponent shift applied to retry delays (`2^n` multiplier).
const MAX_RETRY_EXPONENT_SHIFT: u32 = 6;
/// Maximum delay applied to a `Retry-After` header value / rate-limit backoff.
///
/// Some providers (especially TPM-based rate limits on aggregator platforms
/// like NVIDIA's integrate API) return large `Retry-After` values of 30-60
/// seconds. Capping at 10s caused tight retry loops that burned through the
/// user's request budget without actually waiting for the TPM window to reset.
/// 60s is a reasonable upper bound that respects provider guidance without
/// locking the user into an interminable stall.
const MAX_RETRY_AFTER_DELAY_MS: u64 = 60_000;

enum StreamSendOutcome {
    Response(reqwest::Response),
    Transport(reqwest::Error),
    TtftTimeout,
}

async fn send_stream_request(
    request: reqwest::RequestBuilder,
    request_body: &serde_json::Value,
    ttft_timeout: Option<Duration>,
) -> StreamSendOutcome {
    match ttft_timeout {
        Some(timeout) => {
            match tokio::time::timeout(timeout, request.json(request_body).send()).await {
                Ok(Ok(response)) => StreamSendOutcome::Response(response),
                Ok(Err(error)) => StreamSendOutcome::Transport(error),
                Err(_) => StreamSendOutcome::TtftTimeout,
            }
        }
        None => match request.json(request_body).send().await {
            Ok(response) => StreamSendOutcome::Response(response),
            Err(error) => StreamSendOutcome::Transport(error),
        },
    }
}

fn format_ttft_timeout_error(label: &str, ttft_timeout: Option<Duration>) -> String {
    let timeout_secs = ttft_timeout.map(|timeout| timeout.as_secs()).unwrap_or(0);
    format!(
        "{} TTFT timeout after {}s waiting for first effective stream output",
        label, timeout_secs
    )
}

fn remaining_ttft_timeout(
    started_at: std::time::Instant,
    ttft_timeout: Option<Duration>,
) -> Option<Duration> {
    ttft_timeout.map(|timeout| timeout.saturating_sub(started_at.elapsed()))
}

fn format_transport_error(label: &str, error: &reqwest::Error) -> String {
    let mut message = format!("{} connection failed: {}", label, error);
    let mut source = error.source();
    let mut index = 1;

    while let Some(cause) = source {
        message.push_str(&format!("; cause {}: {}", index, cause));
        source = cause.source();
        index += 1;
    }

    message
}

fn transport_provider_error(label: &str, error: &reqwest::Error) -> AiProviderError {
    // send() has not yielded a response or any model output. Preserve reqwest's
    // typed cause: OS-localized messages and URL text cannot classify transport.
    let category = if error.is_timeout() {
        ErrorCategory::Timeout
    } else if error.is_builder() || error.is_redirect() {
        ErrorCategory::InvalidRequest
    } else {
        ErrorCategory::Network
    };
    let mut provider_error =
        AiProviderError::classified(format_transport_error(label, error), category);
    provider_error.provider = Some(label.to_string());
    provider_error
}

fn provider_error_code(body: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let error = value.get("error").unwrap_or(&value);
    ["code", "type", "status"].iter().find_map(|field| {
        error.get(field).and_then(|value| match value {
            serde_json::Value::String(value) => Some(value.clone()),
            serde_json::Value::Number(value) => Some(value.to_string()),
            _ => None,
        })
    })
}

fn http_provider_error(
    label: &str,
    status: StatusCode,
    error_text: &str,
    error_kind: &str,
    retry_after_ms: Option<u64>,
) -> AiProviderError {
    let mut error = AiProviderError::from_parts(
        format!("{} {} {}: {}", label, error_kind, status, error_text),
        Some(label.to_string()),
        provider_error_code(error_text),
        Some(status.as_u16()),
    )
    .with_retry_after_ms(retry_after_ms);
    // Kimi Coding reports exhausted concurrent-request capacity as 403 with
    // access_terminated_error. Preserve those raw facts, but do not tell the
    // user to replace valid credentials or use permission-error backoff.
    if is_provider_concurrency_limit(status, error_text) {
        error.category = ErrorCategory::RateLimit;
    }
    error
}

fn is_provider_concurrency_limit(status: StatusCode, body: &str) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(body) else {
        return false;
    };
    let error = value.get("error").unwrap_or(&value);
    let message = error
        .get("message")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let explicit_capacity_message = message.contains("concurrent request limit")
        || message.contains("concurrency limit")
        || message.contains("concurrency exceeded");
    explicit_capacity_message
        && (status == StatusCode::TOO_MANY_REQUESTS
            || (status == StatusCode::FORBIDDEN
                && provider_error_code(body).as_deref() == Some("access_terminated_error")))
}

fn exponential_retry_delay_ms(attempt: usize) -> u64 {
    let shift = u32::try_from(attempt)
        .unwrap_or(u32::MAX)
        .min(MAX_RETRY_EXPONENT_SHIFT);
    BASE_RETRY_DELAY_MS
        .saturating_mul(1u64 << shift)
        .min(MAX_EXPONENTIAL_DELAY_MS)
}

fn rate_limit_retry_delay_ms(attempt: usize) -> u64 {
    let shift = u32::try_from(attempt)
        .unwrap_or(u32::MAX)
        .min(MAX_RETRY_EXPONENT_SHIFT);
    RATE_LIMIT_BASE_RETRY_DELAY_MS
        .saturating_mul(1u64 << shift)
        .min(MAX_RETRY_AFTER_DELAY_MS)
}

/// Upper bound for a provider recovery hint used as routing cooldown. Written
/// allowance resets beyond a week are treated as malformed, not as fact.
const MAX_PROVIDER_RECOVERY_HINT_MS: u64 = 8 * 24 * 60 * 60 * 1000;

/// Structured `Retry-After`, uncapped by the per-sleep limit so routing can
/// keep an exhausted account cooled until the provider says it recovers.
fn retry_after_hint_ms(headers: &HeaderMap) -> Option<u64> {
    let value = headers.get(RETRY_AFTER)?.to_str().ok()?.trim();

    if let Ok(seconds) = value.parse::<u64>() {
        return Some(
            seconds
                .saturating_mul(1000)
                .min(MAX_PROVIDER_RECOVERY_HINT_MS),
        );
    }

    let retry_at = DateTime::parse_from_rfc2822(value)
        .ok()?
        .with_timezone(&Utc);
    Some(delay_until_ms(retry_at.timestamp(), Utc::now().timestamp()))
}

fn delay_until_ms(at: i64, now: i64) -> u64 {
    u64::try_from(at.saturating_sub(now).max(0))
        .unwrap_or(0)
        .saturating_mul(1000)
        .min(MAX_PROVIDER_RECOVERY_HINT_MS)
}

/// Allowance resets reported in the error body, e.g. ChatGPT's
/// `usage_limit_reached` carries `resets_at` (unix seconds) or
/// `resets_in_seconds`.
fn body_recovery_hint_ms(body: &str, now: i64) -> Option<u64> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let error = value.get("error").unwrap_or(&value);
    if let Some(at) = error.get("resets_at").and_then(serde_json::Value::as_i64) {
        return (at > now).then(|| delay_until_ms(at, now));
    }
    error
        .get("resets_in_seconds")
        .and_then(serde_json::Value::as_u64)
        .filter(|seconds| *seconds > 0)
        .map(|seconds| {
            seconds
                .saturating_mul(1000)
                .min(MAX_PROVIDER_RECOVERY_HINT_MS)
        })
}

fn provider_recovery_hint_ms(headers: &HeaderMap, body: &str) -> Option<u64> {
    let header = retry_after_hint_ms(headers);
    let body = body_recovery_hint_ms(body, Utc::now().timestamp());
    header.max(body)
}

fn retry_after_delay_ms(headers: &HeaderMap) -> Option<u64> {
    retry_after_hint_ms(headers).map(|delay| delay.min(MAX_RETRY_AFTER_DELAY_MS))
}

fn retry_delay_ms(attempt: usize, headers: &HeaderMap, status: StatusCode) -> u64 {
    let fallback = if status == StatusCode::TOO_MANY_REQUESTS {
        rate_limit_retry_delay_ms(attempt)
    } else {
        exponential_retry_delay_ms(attempt)
    };

    match retry_after_delay_ms(headers) {
        // Honor Retry-After, but never let a tiny/zero value defeat the
        // rate-limit ladder (common with aggregator "Retry-After: 1" responses).
        Some(retry_after) if status == StatusCode::TOO_MANY_REQUESTS => {
            retry_after.max(fallback).min(MAX_RETRY_AFTER_DELAY_MS)
        }
        Some(retry_after) if retry_after > 0 => retry_after,
        Some(_) | None => fallback,
    }
}

struct ManagedResponseStream {
    inner: UnboundedReceiverStream<Result<UnifiedResponse>>,
    handler_cancel: CancellationToken,
    handler_task: Option<JoinHandle<()>>,
    completion: Option<RequestCompletion>,
    normal_completion: bool,
}

impl ManagedResponseStream {
    fn new(
        rx: mpsc::UnboundedReceiver<Result<UnifiedResponse>>,
        handler_cancel: CancellationToken,
        handler_task: JoinHandle<()>,
        completion: Option<RequestCompletion>,
    ) -> Self {
        Self {
            inner: UnboundedReceiverStream::new(rx),
            handler_cancel,
            handler_task: Some(handler_task),
            completion,
            normal_completion: false,
        }
    }
}

impl Stream for ManagedResponseStream {
    type Item = Result<UnifiedResponse>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let next = Pin::new(&mut self.inner).poll_next(cx);
        match &next {
            Poll::Ready(Some(Ok(chunk))) => {
                if let Some(completion) = chunk.tool_call_completion {
                    if matches!(
                        completion,
                        ToolCallCompletion::NormalToolUse | ToolCallCompletion::NormalNoToolUse
                    ) {
                        self.normal_completion = true;
                    } else {
                        // Truncated/failed/unknown terminal output is not
                        // evidence that the request completed successfully.
                        self.completion.take();
                    }
                }
            }
            Poll::Ready(Some(Err(_))) => {
                self.completion.take();
            }
            Poll::Ready(None) => {
                let handler_succeeded = match self.handler_task.as_mut() {
                    Some(task) => match Pin::new(task).poll(cx) {
                        Poll::Pending => return Poll::Pending,
                        Poll::Ready(result) => result.is_ok(),
                    },
                    None => false,
                };
                self.handler_task.take();
                if let Some(completion) = self.completion.take() {
                    if self.normal_completion
                        && handler_succeeded
                        && !self.handler_cancel.is_cancelled()
                    {
                        completion.succeeded();
                    }
                }
            }
            Poll::Pending => {}
        }
        next
    }
}

impl Drop for ManagedResponseStream {
    fn drop(&mut self) {
        self.handler_cancel.cancel();
        let _ = self.handler_task.take();
    }
}

pub(crate) async fn execute_sse_request<BuildRequest, BuildHandler, HandlerFuture>(
    account_client: Option<&crate::client::AIClient>,
    label: &str,
    url: &str,
    request_body: &serde_json::Value,
    max_tries: usize,
    ttft_timeout: Option<Duration>,
    trace: Option<ModelExchangeTraceConfig>,
    build_request: BuildRequest,
    build_handler: BuildHandler,
) -> Result<StreamResponse>
where
    BuildRequest: Fn() -> reqwest::RequestBuilder,
    BuildHandler: Fn(
        reqwest::Response,
        mpsc::UnboundedSender<Result<UnifiedResponse>>,
        Option<mpsc::UnboundedSender<String>>,
        Option<Duration>,
    ) -> HandlerFuture,
    HandlerFuture: Future<Output = ()> + Send + 'static,
{
    execute_sse_request_with_http_fallback(
        account_client,
        label,
        url,
        request_body,
        max_tries,
        ttft_timeout,
        trace,
        build_request,
        build_handler,
        |_, _, _| None,
    )
    .await
}

/// Allow one provider-owned request adaptation after an HTTP rejection, before
/// a stream is exposed. It gets one extra send even when the runtime owns the
/// retry budget (`max_tries == 1`); ordinary retries retain the adapted body.
/// Every send still goes through admission, authorization and attempt tracing.
pub(crate) async fn execute_sse_request_with_http_fallback<
    BuildRequest,
    BuildHandler,
    HandlerFuture,
    HttpFallback,
>(
    account_client: Option<&crate::client::AIClient>,
    label: &str,
    url: &str,
    request_body: &serde_json::Value,
    mut max_tries: usize,
    ttft_timeout: Option<Duration>,
    trace: Option<ModelExchangeTraceConfig>,
    build_request: BuildRequest,
    build_handler: BuildHandler,
    http_fallback: HttpFallback,
) -> Result<StreamResponse>
where
    BuildRequest: Fn() -> reqwest::RequestBuilder,
    BuildHandler: Fn(
        reqwest::Response,
        mpsc::UnboundedSender<Result<UnifiedResponse>>,
        Option<mpsc::UnboundedSender<String>>,
        Option<Duration>,
    ) -> HandlerFuture,
    HandlerFuture: Future<Output = ()> + Send + 'static,
    HttpFallback: Fn(StatusCode, &str, &serde_json::Value) -> Option<serde_json::Value>,
{
    let mut last_error = None;
    let mut request_body = Cow::Borrowed(request_body);
    let mut fallback_used = false;
    let mut attempts = 0;
    while attempts < max_tries {
        let attempt = attempts;
        attempts += 1;
        let request = build_request();
        let capacity = RequestCapacity::for_request(&request)?;
        // Queuing is cancellable by dropping this future and must not consume
        // the first-output timeout or another transport attempt.
        let queue_started_at = std::time::Instant::now();
        let mut request_permit = capacity.acquire().await;
        if let Some(authorization) =
            account_client.and_then(|client| client.request_authorization.as_ref())
        {
            authorization.validate().await?;
        }
        #[cfg(feature = "subscription-auth")]
        if let Some((client, identity)) = account_client.and_then(|client| {
            client
                .account_identity
                .as_ref()
                .map(|identity| (client, identity))
        }) {
            // Queueing may outlive logout, disable, refresh or seat replacement.
            identity.validate(client).await?;
        }
        #[cfg(not(feature = "subscription-auth"))]
        let _ = account_client;
        let queue_wait_ms = elapsed_ms_u64(queue_started_at);
        if queue_wait_ms > 0 {
            debug!(
                "{} request admission queue released: queue_wait_ms={}",
                label, queue_wait_ms
            );
        }
        let trace_handle = if let Some(trace) = trace.as_ref() {
            trace
                .sink
                .request_attempt_started(&ModelExchangeRequestAttempt {
                    request_url: url.to_string(),
                    request_body: trace
                        .capture_request_body
                        .then(|| request_body.as_ref().clone()),
                    attempt_number: attempt + 1,
                    round_attempt: trace.round_attempt().cloned(),
                })
                .await
        } else {
            None
        };
        let request_start_time = std::time::Instant::now();
        let send_outcome = send_stream_request(request, &request_body, ttft_timeout).await;

        let response = match send_outcome {
            StreamSendOutcome::Response(resp) => {
                let connect_time = elapsed_ms_u64(request_start_time);
                let status = resp.status();
                let http_version = resp.version();
                let headers = resp.headers().clone();

                if status.is_success() {
                    debug!(
                        "{} request connected: {}ms, status: {}, protocol: {:?}, transport_attempt: {}/{}",
                        label,
                        connect_time,
                        status,
                        http_version,
                        attempt + 1,
                        max_tries
                    );
                    resp
                } else {
                    let read_error_body = async {
                        resp.text()
                            .await
                            .unwrap_or_else(|e| format!("Failed to read error response: {}", e))
                    };
                    // Headers are not effective output. A stalled error body
                    // must not outlive TTFT and pin a credential's only slot.
                    let (error_text, error_body_timed_out) =
                        match remaining_ttft_timeout(request_start_time, ttft_timeout) {
                            Some(timeout) => {
                                match tokio::time::timeout(timeout, read_error_body).await {
                                    Ok(body) => (body, false),
                                    Err(_) => (
                                        format!(
                                            "{}; timed out reading error response body",
                                            format_ttft_timeout_error(label, ttft_timeout)
                                        ),
                                        true,
                                    ),
                                }
                            }
                            None => (read_error_body.await, false),
                        };
                    let error_kind = if status.is_client_error() {
                        "client error"
                    } else {
                        "error"
                    };
                    let concurrency_limited = is_provider_concurrency_limit(status, &error_text);
                    let retry_status = if concurrency_limited {
                        StatusCode::TOO_MANY_REQUESTS
                    } else {
                        status
                    };
                    if concurrency_limited {
                        request_permit.concurrency_rejected(Duration::from_millis(retry_delay_ms(
                            attempt,
                            &headers,
                            retry_status,
                        )));
                        warn!("{} provider concurrency limit reached; subsequent requests will wait for stream capacity", label);
                    }
                    drop(request_permit);
                    let mut provider_error = http_provider_error(
                        label,
                        status,
                        &error_text,
                        error_kind,
                        provider_recovery_hint_ms(&headers, &error_text),
                    );
                    if error_body_timed_out {
                        // Keep the HTTP status, but do not report a partially
                        // received 403 as a confirmed credential failure.
                        provider_error.category = ErrorCategory::Timeout;
                    }
                    let error = anyhow!(provider_error);
                    warn!(
                        "{} request failed: {}ms, transport_attempt {}/{}, error: {}",
                        label,
                        connect_time,
                        attempt + 1,
                        max_tries,
                        error
                    );
                    last_error = Some(error);
                    if let Some(trace) = trace.as_ref() {
                        trace
                            .sink
                            .request_attempt_failed(
                                trace_handle.as_ref(),
                                &last_error
                                    .as_ref()
                                    .map(ToString::to_string)
                                    .unwrap_or_else(|| "unknown error".to_string()),
                            )
                            .await;
                    }

                    if !fallback_used && !error_body_timed_out {
                        if let Some(adapted_body) =
                            http_fallback(status, &error_text, &request_body)
                        {
                            request_body = Cow::Owned(adapted_body);
                            fallback_used = true;
                            max_tries = max_tries.saturating_add(1);
                            warn!(
                                "{} retrying with provider compatibility fallback after HTTP {}",
                                label, status
                            );
                            continue;
                        }
                    }

                    if attempt < max_tries - 1 {
                        let delay_ms = retry_delay_ms(attempt, &headers, retry_status);
                        debug!(
                            "Retrying {} after {}ms (transport_attempt {}, status {})",
                            label,
                            delay_ms,
                            attempt + 2,
                            status
                        );
                        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                    }
                    continue;
                }
            }
            StreamSendOutcome::Transport(e) => {
                drop(request_permit);
                let connect_time = request_start_time.elapsed().as_millis();
                let provider_error = transport_provider_error(label, &e);
                let error_msg = provider_error.message.clone();
                let error = anyhow!(provider_error);
                warn!(
                    "{} request failed: {}ms, transport_attempt {}/{}, error: {}",
                    label,
                    connect_time,
                    attempt + 1,
                    max_tries,
                    error_msg
                );
                last_error = Some(error);
                if let Some(trace) = trace.as_ref() {
                    trace
                        .sink
                        .request_attempt_failed(trace_handle.as_ref(), &error_msg)
                        .await;
                }

                if attempt < max_tries - 1 {
                    let delay_ms = exponential_retry_delay_ms(attempt);
                    debug!(
                        "Retrying {} after {}ms (transport_attempt {})",
                        label,
                        delay_ms,
                        attempt + 2
                    );
                    tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                }
                continue;
            }
            StreamSendOutcome::TtftTimeout => {
                drop(request_permit);
                let connect_time = request_start_time.elapsed().as_millis();
                let error_msg = format_ttft_timeout_error(label, ttft_timeout);
                let error = anyhow!("{}", error_msg);
                warn!(
                    "{} request failed: {}ms, transport_attempt {}/{}, error: {}",
                    label,
                    connect_time,
                    attempt + 1,
                    max_tries,
                    error_msg
                );
                last_error = Some(error);
                if let Some(trace) = trace.as_ref() {
                    trace
                        .sink
                        .request_attempt_failed(trace_handle.as_ref(), &error_msg)
                        .await;
                }

                if attempt < max_tries - 1 {
                    let delay_ms = exponential_retry_delay_ms(attempt);
                    debug!(
                        "Retrying {} after {}ms (transport_attempt {})",
                        label,
                        delay_ms,
                        attempt + 2
                    );
                    tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                }
                continue;
            }
        };

        let (tx, rx) = mpsc::unbounded_channel();
        let (tx_raw, rx_raw) = mpsc::unbounded_channel();
        let remaining_ttft_timeout = remaining_ttft_timeout(request_start_time, ttft_timeout);
        let handler_cancel = CancellationToken::new();
        let handler_cancel_for_task = handler_cancel.clone();
        let completion = request_permit.take_completion();
        let handler_future = build_handler(response, tx, Some(tx_raw), remaining_ttft_timeout);
        let handler_task = tokio::spawn(async move {
            // Release as soon as the response handler ends or is cancelled,
            // not after the Agent finishes its tools or the UI drains chunks.
            let _request_permit = request_permit;
            tokio::select! {
                _ = handler_cancel_for_task.cancelled() => {}
                _ = handler_future => {}
            }
        });

        return Ok(StreamResponse {
            stream: Box::pin(ManagedResponseStream::new(
                rx,
                handler_cancel,
                handler_task,
                Some(completion),
            )),
            raw_sse_rx: Some(rx_raw),
            trace_handle,
        });
    }

    let last_error = last_error.unwrap_or_else(|| anyhow!("Unknown error"));
    if max_tries == 1 {
        // The runtime owns the retry budget. A redundant "after 1 attempts"
        // context hides the actual timeout/connection error from Display.
        return Err(last_error);
    }
    let error_context = format!("{} failed after {} attempts", label, max_tries);
    error!("{}: {}", error_context, last_error);
    Err(last_error.context(error_context))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::State;
    use axum::response::IntoResponse;
    use axum::routing::post;
    use axum::{Json, Router};
    use futures::StreamExt;
    use openbitfun_core_types::errors::ErrorCategory;
    use reqwest::header::HeaderValue;
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    };

    const CONCURRENCY_ERROR: &str = r#"{"error":{"message":"You've reached your concurrent request limit. Please wait for your ongoing requests to finish and try again.","type":"access_terminated_error"}}"#;

    #[tokio::test]
    async fn single_attempt_connection_refused_preserves_network_category() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        // A URL may contain words used by the legacy text classifier. The
        // transport's typed cause, not the URL or OS language, owns admission.
        let url = format!("http://{address}/timeout/invalid_request_error/v1/messages");
        let client = crate::client::http::create_http_client(None, false);
        let result = execute_sse_request(
            None,
            "Anthropic Streaming API",
            &url,
            &serde_json::json!({"model": "test"}),
            1,
            None,
            None,
            || client.post(&url),
            |_response, tx, _tx_raw, _remaining_ttft_timeout| async move {
                drop(tx);
            },
        )
        .await;
        let error = match result {
            Ok(_) => panic!("closed port must fail before any output"),
            Err(error) => error,
        };
        let provider_error = error
            .downcast_ref::<AiProviderError>()
            .expect("transport failure must remain a structured provider error");
        assert_eq!(provider_error.category, ErrorCategory::Network);
        assert_eq!(
            provider_error.provider.as_deref(),
            Some("Anthropic Streaming API")
        );
        assert_eq!(provider_error.http_status, None);
        assert!(provider_error.message.contains("cause 1:"));
        assert!(provider_error.message.contains(&address.to_string()));
    }

    #[tokio::test]
    async fn transport_provider_error_preserves_timeout_and_invalid_request_categories() {
        let client = crate::client::http::create_http_client(None, false);
        let invalid = client.post("not a valid URL").send().await.unwrap_err();
        assert!(invalid.is_builder());
        assert_eq!(
            transport_provider_error("Anthropic Streaming API", &invalid).category,
            ErrorCategory::InvalidRequest,
        );

        // Keep the listener open but never respond. The request deadline must
        // remain Timeout rather than being flattened into a generic Network.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let timeout = client
            .post(format!(
                "http://{}/v1/messages",
                listener.local_addr().unwrap()
            ))
            .timeout(Duration::from_millis(50))
            .send()
            .await
            .unwrap_err();
        assert!(timeout.is_timeout());
        assert_eq!(
            transport_provider_error("Anthropic Streaming API", &timeout).category,
            ErrorCategory::Timeout,
        );
    }

    async fn limited_scope(name: &str) -> Arc<RequestCapacity> {
        let client = crate::client::http::create_http_client(None, false);
        let scope = RequestCapacity::for_request(
            &client
                .post("https://stream-recovery.example/v1")
                .bearer_auth(name),
        )
        .unwrap();
        let request = scope.acquire().await;
        request.concurrency_rejected(Duration::ZERO);
        drop(request);
        scope
    }

    fn normal_terminal() -> Result<UnifiedResponse> {
        Ok(UnifiedResponse {
            finish_reason: Some("tool_calls".to_string()),
            tool_call_completion: Some(ToolCallCompletion::NormalToolUse),
            ..Default::default()
        })
    }

    async fn response_fixture(
        scope: &Arc<RequestCapacity>,
        chunks: Vec<Result<UnifiedResponse>>,
        handler_panics: bool,
    ) -> ManagedResponseStream {
        let mut request = scope.acquire().await;
        let completion = request.take_completion();
        let (tx, rx) = mpsc::unbounded_channel();
        let handler = tokio::spawn(async move {
            let _request = request;
            for chunk in chunks {
                tx.send(chunk).unwrap();
            }
            assert!(!handler_panics, "fixture handler panic");
        });
        ManagedResponseStream::new(rx, CancellationToken::new(), handler, Some(completion))
    }

    async fn assert_single_slot(scope: &Arc<RequestCapacity>, case: &str) {
        let _first = tokio::time::timeout(Duration::from_millis(100), scope.acquire())
            .await
            .unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(20), scope.acquire())
                .await
                .is_err(),
            "{case} must not promote the concurrency window"
        );
    }

    #[tokio::test]
    async fn incomplete_failed_and_unconsumed_streams_do_not_promote_capacity() {
        for case in [
            "empty",
            "partial",
            "late-error",
            "output-limit",
            "unknown",
            "panic",
            "unconsumed",
        ] {
            let scope = limited_scope(case).await;
            // A failure must reset the first success, not just avoid counting
            // itself; the next success alone must not promote the window.
            let first = response_fixture(&scope, vec![normal_terminal()], false).await;
            first.collect::<Vec<_>>().await;
            let chunks = match case {
                "empty" => vec![],
                "partial" => vec![Ok(UnifiedResponse {
                    text: Some("partial".to_string()),
                    ..Default::default()
                })],
                "late-error" => vec![normal_terminal(), Err(anyhow!("fixture stream timeout"))],
                "output-limit" | "unknown" => vec![Ok(UnifiedResponse {
                    finish_reason: Some(case.to_string()),
                    tool_call_completion: Some(if case == "output-limit" {
                        ToolCallCompletion::OutputLimit
                    } else {
                        ToolCallCompletion::Unknown
                    }),
                    ..Default::default()
                })],
                _ => vec![normal_terminal()],
            };
            let mut stream = response_fixture(&scope, chunks, case == "panic").await;
            if case == "unconsumed" {
                stream.handler_task.as_mut().unwrap().await.unwrap();
                // An unread response must not hold transport capacity hostage.
                let slot = tokio::time::timeout(Duration::from_millis(100), scope.acquire())
                    .await
                    .unwrap();
                drop(slot);
                drop(stream);
            } else {
                stream.collect::<Vec<_>>().await;
            }
            let next = response_fixture(&scope, vec![normal_terminal()], false).await;
            next.collect::<Vec<_>>().await;
            assert_single_slot(&scope, case).await;
        }
    }

    #[tokio::test]
    async fn cancellation_after_a_terminal_chunk_is_not_a_successful_sample() {
        let scope = limited_scope("cancel-after-terminal").await;
        for _ in 0..2 {
            let mut request = scope.acquire().await;
            let completion = request.take_completion();
            let (tx, rx) = mpsc::unbounded_channel();
            let cancelled = CancellationToken::new();
            let handler_cancelled = cancelled.clone();
            let handler = tokio::spawn(async move {
                let _request = request;
                tx.send(normal_terminal()).unwrap();
                handler_cancelled.cancelled().await;
            });
            let mut stream =
                ManagedResponseStream::new(rx, cancelled.clone(), handler, Some(completion));
            assert!(stream.next().await.unwrap().is_ok());
            cancelled.cancel();
            assert!(stream.next().await.is_none());
        }
        assert_single_slot(&scope, "cancelled stream").await;
    }

    #[tokio::test]
    async fn normal_tool_completion_is_counted_once_even_when_eof_is_polled_again() {
        let scope = limited_scope("repeated-eof").await;
        let mut first = response_fixture(&scope, vec![normal_terminal()], false).await;
        assert!(first.next().await.unwrap().is_ok());
        for _ in 0..4 {
            assert!(first.next().await.is_none());
        }
        // A single completion has not filled two successful windows yet.
        let mut held = scope.acquire().await;
        assert!(
            tokio::time::timeout(Duration::from_millis(20), scope.acquire())
                .await
                .is_err()
        );
        held.take_completion().succeeded();
        let _second = tokio::time::timeout(Duration::from_millis(100), scope.acquire())
            .await
            .unwrap();
    }

    #[test]
    fn provider_concurrency_403_is_rate_limit_not_permission() {
        let error = http_provider_error(
            "OpenAI Streaming API",
            StatusCode::FORBIDDEN,
            CONCURRENCY_ERROR,
            "client error",
            None,
        );
        assert_eq!(error.category, ErrorCategory::RateLimit);
        assert_eq!(error.http_status, Some(403));
        assert_eq!(
            error.provider_code.as_deref(),
            Some("access_terminated_error")
        );
        assert_eq!(error.detail().retryable, Some(true));
    }

    #[test]
    fn other_access_terminated_errors_remain_permission_errors() {
        let error = http_provider_error(
            "OpenAI Streaming API",
            StatusCode::FORBIDDEN,
            r#"{"error":{"message":"Access to this model has been terminated","type":"access_terminated_error"}}"#,
            "client error",
            None,
        );
        assert_eq!(error.category, ErrorCategory::Permission);
    }

    #[derive(Clone)]
    struct RetryFixtureState {
        attempts: Arc<AtomicUsize>,
    }

    async fn bad_requests_then_success(
        State(state): State<RetryFixtureState>,
        Json(body): Json<serde_json::Value>,
    ) -> impl IntoResponse {
        assert_eq!(body["model"], "configured-model");
        match state.attempts.fetch_add(1, Ordering::SeqCst) {
            0 => (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": {
                        "message": "Invalid temperature value",
                        "type": "invalid_request_error",
                        "code": "invalid_parameter"
                    }
                })),
            )
                .into_response(),
            1 => (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": {
                        "message": "Maximum context length exceeded",
                        "type": "invalid_request_error",
                        "code": "context_length_exceeded"
                    }
                })),
            )
                .into_response(),
            _ => StatusCode::OK.into_response(),
        }
    }

    async fn forbidden_with_retry_after(Json(body): Json<serde_json::Value>) -> impl IntoResponse {
        assert_eq!(body["model"], "configured-model");
        (
            StatusCode::FORBIDDEN,
            [("retry-after", "7")],
            Json(serde_json::json!({
                "error": {
                    "message": "provider authorization denied",
                    "type": "permission_error",
                    "code": "permission_denied"
                }
            })),
        )
    }

    async fn concurrency_rejection_then_success(
        State(state): State<RetryFixtureState>,
    ) -> impl IntoResponse {
        if state.attempts.fetch_add(1, Ordering::SeqCst) == 0 {
            (StatusCode::FORBIDDEN, CONCURRENCY_ERROR).into_response()
        } else {
            (
                [("content-type", "text/event-stream")],
                "data: {\"id\":\"fixture\",\"object\":\"chat.completion.chunk\",\"model\":\"fixture\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n",
            )
                .into_response()
        }
    }

    #[tokio::test]
    async fn completed_streams_recover_parallel_capacity_without_an_idle_period() {
        use futures::StreamExt;

        let app = Router::new()
            .route(
                "/chat/completions",
                post(concurrency_rejection_then_success),
            )
            .with_state(RetryFixtureState {
                attempts: Arc::new(AtomicUsize::new(0)),
            });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/chat/completions", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = crate::client::http::create_http_client(None, false);
        let body = serde_json::json!({"model": "fixture"});
        let open = || {
            execute_sse_request(
                None,
                "OpenAI Streaming API",
                &url,
                &body,
                1,
                Some(Duration::from_secs(1)),
                None,
                || client.post(&url).bearer_auth("recovery-fixture-key"),
                |response, tx, raw, ttft| {
                    crate::stream::handle_openai_stream(response, tx, raw, false, ttft, None)
                },
            )
        };
        assert!(
            open().await.is_err(),
            "first request hits the provider limit"
        );
        for _ in 0..2 {
            let mut response = open().await.unwrap();
            let mut normal_completion = false;
            while let Some(chunk) = response.stream.next().await {
                normal_completion |= chunk.unwrap().tool_call_completion
                    == Some(ToolCallCompletion::NormalNoToolUse);
            }
            assert!(
                normal_completion,
                "fixture must produce a complete normalized response"
            );
        }

        let scope =
            RequestCapacity::for_request(&client.post(&url).bearer_auth("recovery-fixture-key"))
                .unwrap();
        let _first = scope.acquire().await;
        let second = tokio::time::timeout(Duration::from_millis(100), scope.acquire()).await;
        server.abort();
        assert!(
            second.is_ok(),
            "successful streams must restore a second slot without waiting five minutes"
        );
    }

    #[tokio::test]
    async fn concurrency_queue_lives_through_stream_and_does_not_consume_ttft_budget() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let app = Router::new()
            .route(
                "/chat/completions",
                post(concurrency_rejection_then_success),
            )
            .with_state(RetryFixtureState {
                attempts: Arc::clone(&attempts),
            });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/chat/completions", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = crate::client::http::create_http_client(None, false);
        let body = serde_json::json!({"model": "fixture"});

        let error = execute_sse_request(
            None,
            "OpenAI Streaming API",
            &url,
            &body,
            1,
            Some(Duration::from_millis(100)),
            None,
            || client.post(&url).bearer_auth("fixture-key"),
            |_response, _tx, _, _| async {},
        )
        .await
        .err()
        .expect("first request must hit provider concurrency limit");
        assert_eq!(
            error.downcast_ref::<AiProviderError>().unwrap().category,
            ErrorCategory::RateLimit
        );
        assert!(!error.to_string().contains("after 1 attempts"));

        // The provider cooldown is longer than TTFT. It must be spent before
        // the request timer starts, not turn a queued request into a timeout.
        let held = execute_sse_request(
            None,
            "OpenAI Streaming API",
            &url,
            &body,
            1,
            Some(Duration::from_millis(100)),
            None,
            || client.post(&url).bearer_auth("fixture-key"),
            |_response, _tx, _, _| async { std::future::pending::<()>().await },
        )
        .await
        .expect("queued request must get its own TTFT budget");
        let mut next = Box::pin(execute_sse_request(
            None,
            "OpenAI Streaming API",
            &url,
            &body,
            1,
            Some(Duration::from_millis(100)),
            None,
            || client.post(&url).bearer_auth("fixture-key"),
            |_response, _tx, _, _| async {},
        ));
        assert!(tokio::time::timeout(Duration::from_millis(150), &mut next)
            .await
            .is_err());
        assert_eq!(
            attempts.load(Ordering::SeqCst),
            2,
            "queued requests must not reach provider"
        );
        drop(held); // Dropping the stream cancels its handler and releases capacity.
        let result = tokio::time::timeout(Duration::from_secs(1), next)
            .await
            .unwrap();
        assert!(
            result.is_ok(),
            "queue must resume after stream cancellation"
        );
        assert_eq!(attempts.load(Ordering::SeqCst), 3);
        server.abort();
    }

    #[tokio::test]
    async fn single_attempt_timeout_keeps_the_actual_cause_visible() {
        let app = Router::new().route(
            "/chat/completions",
            post(|| async {
                tokio::time::sleep(Duration::from_secs(1)).await;
                StatusCode::OK
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/chat/completions", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = crate::client::http::create_http_client(None, false);
        let error = execute_sse_request(
            None,
            "OpenAI Streaming API",
            &url,
            &serde_json::json!({}),
            1,
            Some(Duration::from_millis(20)),
            None,
            || client.post(&url),
            |_response, _tx, _, _| async {},
        )
        .await
        .err()
        .expect("request should time out");
        assert!(error.to_string().contains("TTFT timeout"));
        assert!(!error.to_string().contains("after 1 attempts"));
        server.abort();
    }

    #[tokio::test]
    async fn short_ttft_still_cancels_stalled_proxy_tls_setup() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (ready_tx, mut ready_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut socket = tokio::io::BufReader::new(socket);
            loop {
                let mut line = String::new();
                if socket.read_line(&mut line).await.unwrap() == 0 {
                    return;
                }
                if line == "\r\n" {
                    break;
                }
            }
            socket
                .get_mut()
                .write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
                .await
                .unwrap();
            let _ = ready_tx.send(());
            // A real proxy may finish CONNECT before TLS becomes ready.
            // Keep this tunnel open without answering the TLS ClientHello.
            std::future::pending::<()>().await;
        });
        let client = crate::client::http::create_http_client(
            Some(crate::types::ProxyConfig {
                enabled: true,
                url: format!("http://{address}"),
                username: None,
                password: None,
            }),
            false,
        );
        let outcome = send_stream_request(
            client.post("https://transport-budget.invalid/v1/chat/completions"),
            &serde_json::json!({}),
            Some(Duration::from_millis(100)),
        )
        .await;
        server.abort();
        let _ = server.await;
        assert!(
            ready_rx.try_recv().is_ok(),
            "the proxy tunnel must have opened"
        );
        assert!(matches!(outcome, StreamSendOutcome::TtftTimeout));
    }

    #[tokio::test]
    async fn stalled_error_body_times_out_and_releases_limited_capacity() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let fixture_attempts = Arc::clone(&attempts);
        let app = Router::new().route(
            "/chat/completions",
            post(move || {
                let attempts = Arc::clone(&fixture_attempts);
                async move {
                    match attempts.fetch_add(1, Ordering::SeqCst) {
                        0 => (StatusCode::FORBIDDEN, CONCURRENCY_ERROR).into_response(),
                        1 => (
                            StatusCode::FORBIDDEN,
                            axum::body::Body::from_stream(futures::stream::pending::<
                                std::result::Result<axum::body::Bytes, std::convert::Infallible>,
                            >()),
                        )
                            .into_response(),
                        _ => StatusCode::OK.into_response(),
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/chat/completions", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = crate::client::http::create_http_client(None, false);
        let body = serde_json::json!({});
        let open = || {
            execute_sse_request(
                None,
                "OpenAI Streaming API",
                &url,
                &body,
                1,
                Some(Duration::from_millis(100)),
                None,
                || client.post(&url).bearer_auth("stalled-error-fixture"),
                |_response, _tx, _, _| async {},
            )
        };
        assert!(open().await.is_err());
        // Includes the two-second provider cooldown before the next request's
        // TTFT budget begins. Headers alone must not disable that deadline.
        let result = tokio::time::timeout(Duration::from_secs(3), open()).await;
        if result.is_err() {
            server.abort();
        }
        let error = result
            .expect("an unfinished error body must not hold capacity indefinitely")
            .err()
            .expect("the error body must time out");
        let provider = error.downcast_ref::<AiProviderError>().unwrap();
        assert_eq!(provider.category, ErrorCategory::Timeout);
        assert_eq!(provider.http_status, Some(403));
        assert!(provider.message.contains("reading error response body"));
        let next = tokio::time::timeout(Duration::from_secs(1), open()).await;
        server.abort();
        assert!(next.unwrap().is_ok(), "timeout must release the only slot");
        assert_eq!(attempts.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn http_error_uses_structured_code_before_generic_message() {
        let error = http_provider_error(
            "OpenAI Responses API",
            StatusCode::BAD_REQUEST,
            r#"{"error":{"code":"context_length_exceeded","message":"Request failed"}}"#,
            "client error",
            None,
        );

        assert_eq!(error.category, ErrorCategory::ContextOverflow);
        assert_eq!(
            error.provider_code.as_deref(),
            Some("context_length_exceeded")
        );
        assert_eq!(error.http_status, Some(400));
    }

    #[test]
    fn no_body_bad_request_is_not_assumed_to_be_context_overflow() {
        let error = http_provider_error(
            "OpenAI Responses API",
            StatusCode::BAD_REQUEST,
            "400 status code (no body)",
            "client error",
            None,
        );

        assert_eq!(error.category, ErrorCategory::InvalidRequest);
    }

    #[test]
    fn format_ttft_timeout_error_includes_timeout_seconds() {
        let message = format_ttft_timeout_error(
            "Codex ChatGPT Responses API",
            Some(std::time::Duration::from_secs(30)),
        );

        assert!(message.contains("TTFT timeout after 30s"));
        assert!(message.contains("first effective stream output"));
    }

    #[test]
    fn remaining_ttft_timeout_subtracts_elapsed_request_time() {
        let start = std::time::Instant::now() - Duration::from_secs(2);
        let remaining = remaining_ttft_timeout(start, Some(Duration::from_secs(5)));

        let remaining = remaining.expect("remaining timeout");
        assert!(remaining <= Duration::from_secs(3));
        assert!(remaining > Duration::from_secs(2));
    }

    #[tokio::test]
    async fn managed_response_stream_drop_cancels_handler_task() {
        let (_tx, rx) = mpsc::unbounded_channel();
        let handler_cancel = CancellationToken::new();
        let handler_cancel_for_task = handler_cancel.clone();
        let observed_cancel = Arc::new(AtomicBool::new(false));
        let observed_cancel_for_task = Arc::clone(&observed_cancel);
        let handler_task = tokio::spawn(async move {
            tokio::select! {
                _ = handler_cancel_for_task.cancelled() => {
                    observed_cancel_for_task.store(true, Ordering::SeqCst);
                }
                _ = tokio::time::sleep(Duration::from_secs(60)) => {}
            }
        });

        let stream = ManagedResponseStream::new(rx, handler_cancel, handler_task, None);
        drop(stream);

        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(observed_cancel.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn every_bad_request_uses_existing_retry_loop() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let app = Router::new()
            .route("/chat/completions", post(bad_requests_then_success))
            .with_state(RetryFixtureState {
                attempts: Arc::clone(&attempts),
            });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind retry fixture");
        let address = listener.local_addr().expect("retry fixture address");
        let server_task = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("retry fixture should run");
        });
        let url = format!("http://{address}/chat/completions");
        let client = crate::client::http::create_http_client(None, false);
        let request_body = serde_json::json!({"model": "configured-model"});

        let result = execute_sse_request(
            None,
            "OpenAI Streaming API",
            &url,
            &request_body,
            3,
            None,
            None,
            || client.post(&url),
            |_response, tx, _tx_raw, _remaining_ttft_timeout| async move {
                drop(tx);
            },
        )
        .await;

        server_task.abort();
        assert!(
            result.is_ok(),
            "ordinary and context-overflow 400 responses should both retry"
        );
        assert_eq!(attempts.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn host_authorization_is_checked_after_queueing_and_before_each_http_retry() {
        #[derive(Debug)]
        struct Authorization {
            checks: AtomicUsize,
            allowed_checks: AtomicUsize,
        }
        impl crate::client::ModelRequestAuthorization for Authorization {
            fn validate(&self) -> std::pin::Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
                Box::pin(async move {
                    if self.checks.fetch_add(1, Ordering::SeqCst)
                        >= self.allowed_checks.load(Ordering::SeqCst)
                    {
                        return Err(AiProviderError::classified(
                            "Fixture model authorization was revoked".into(),
                            ErrorCategory::InvalidRequest,
                        )
                        .into());
                    }
                    Ok(())
                })
            }
        }
        let attempts = Arc::new(AtomicUsize::new(0));
        let app = Router::new()
            .route("/chat/completions", post(bad_requests_then_success))
            .with_state(RetryFixtureState {
                attempts: attempts.clone(),
            });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/chat/completions", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let http = crate::client::http::create_http_client(None, false);
        let body = serde_json::json!({"model":"configured-model"});
        for queued in [true, false] {
            attempts.store(0, Ordering::SeqCst);
            let authorization = Arc::new(Authorization {
                checks: AtomicUsize::new(0),
                allowed_checks: AtomicUsize::new(1),
            });
            let client = crate::client::AIClient::new(crate::types::AIConfig {
                name: "guard fixture".into(),
                base_url: url.clone(),
                request_url: url.clone(),
                api_key: "synthetic-guard-key".into(),
                model: "configured-model".into(),
                format: "openai".into(),
                context_window: 4096,
                max_tokens: None,
                max_images_per_request: None,
                temperature: None,
                top_p: None,
                inline_think_in_text: false,
                custom_headers: None,
                custom_headers_mode: None,
                skip_ssl_verify: false,
                custom_request_body: None,
                custom_request_body_mode: None,
            })
            .with_request_authorization(authorization.clone());
            let scope =
                RequestCapacity::for_request(&http.post(&url).bearer_auth("synthetic-guard-key"))
                    .unwrap();
            let held = if queued {
                let held = scope.acquire().await;
                held.concurrency_rejected(Duration::ZERO);
                Some(held)
            } else {
                None
            };
            let request = execute_sse_request(
                Some(&client),
                "guard fixture",
                &url,
                &body,
                3,
                None,
                None,
                || {
                    http.post(&url)
                        .bearer_auth("synthetic-guard-key")
                        .json(&body)
                },
                |_response, tx, _, _| async move {
                    drop(tx);
                },
            );
            tokio::pin!(request);
            if queued {
                assert!(
                    tokio::time::timeout(Duration::from_millis(20), &mut request)
                        .await
                        .is_err()
                );
                assert_eq!(
                    authorization.checks.load(Ordering::SeqCst),
                    0,
                    "authorization must run after the queue"
                );
                authorization.allowed_checks.store(0, Ordering::SeqCst);
            }
            drop(held);
            let error = request
                .await
                .err()
                .expect("revoked authorization must stop before the next HTTP send");
            assert_eq!(
                error.downcast_ref::<AiProviderError>().unwrap().category,
                ErrorCategory::InvalidRequest
            );
            assert_eq!(attempts.load(Ordering::SeqCst), usize::from(!queued));
            assert_eq!(
                authorization.checks.load(Ordering::SeqCst),
                if queued { 1 } else { 2 }
            );
            let _released = tokio::time::timeout(Duration::from_millis(100), scope.acquire())
                .await
                .unwrap();
        }
        server.abort();
    }

    #[tokio::test]
    async fn single_attempt_preserves_retry_after_metadata_for_outer_budget() {
        let app = Router::new().route("/chat/completions", post(forbidden_with_retry_after));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind retry-after fixture");
        let address = listener.local_addr().expect("retry-after fixture address");
        let server_task = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("retry-after fixture should run");
        });
        let url = format!("http://{address}/chat/completions");
        let client = crate::client::http::create_http_client(None, false);
        let request_body = serde_json::json!({"model": "configured-model"});

        let result = execute_sse_request(
            None,
            "OpenAI Streaming API",
            &url,
            &request_body,
            1,
            None,
            None,
            || client.post(&url),
            |_response, tx, _tx_raw, _remaining_ttft_timeout| async move {
                drop(tx);
            },
        )
        .await;

        server_task.abort();
        let error = match result {
            Ok(_) => panic!("single forbidden response should fail"),
            Err(error) => error,
        };
        let provider_error = error
            .downcast_ref::<AiProviderError>()
            .expect("structured provider error should survive retry context");
        assert_eq!(provider_error.http_status, Some(403));
        assert_eq!(provider_error.retry_after_ms, Some(7_000));
    }

    #[test]
    fn retry_after_seconds_is_capped() {
        let mut headers = HeaderMap::new();
        headers.insert(RETRY_AFTER, HeaderValue::from_static("120"));

        assert_eq!(
            retry_after_delay_ms(&headers),
            Some(MAX_RETRY_AFTER_DELAY_MS)
        );
    }

    #[test]
    fn recovery_hint_is_not_shortened_to_the_sleep_cap() {
        let mut headers = HeaderMap::new();
        headers.insert(RETRY_AFTER, HeaderValue::from_static("7200"));
        assert_eq!(provider_recovery_hint_ms(&headers, ""), Some(7_200_000));
        assert_eq!(
            retry_after_delay_ms(&headers),
            Some(MAX_RETRY_AFTER_DELAY_MS)
        );
    }

    #[test]
    fn usage_limit_body_supplies_the_allowance_reset() {
        let body = r#"{"error":{"type":"usage_limit_reached","resets_at":1600}}"#;
        assert_eq!(body_recovery_hint_ms(body, 1000), Some(600_000));
        assert_eq!(body_recovery_hint_ms(body, 2000), None);
        let body = r#"{"error":{"type":"usage_limit_reached","resets_in_seconds":90}}"#;
        assert_eq!(body_recovery_hint_ms(body, 1000), Some(90_000));
        let far = r#"{"error":{"resets_in_seconds":99999999}}"#;
        assert_eq!(
            body_recovery_hint_ms(far, 1000),
            Some(MAX_PROVIDER_RECOVERY_HINT_MS)
        );
        assert_eq!(body_recovery_hint_ms("not json", 1000), None);
        let error = http_provider_error(
            "OpenAI Responses API",
            StatusCode::TOO_MANY_REQUESTS,
            r#"{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","resets_in_seconds":90}}"#,
            "client error",
            provider_recovery_hint_ms(&HeaderMap::new(), r#"{"error":{"resets_in_seconds":90}}"#),
        );
        assert_eq!(error.category, ErrorCategory::ProviderQuota);
        assert_eq!(error.retry_after_ms, Some(90_000));
    }

    #[test]
    fn retry_after_preserves_sub_cap_values() {
        let mut headers = HeaderMap::new();
        headers.insert(RETRY_AFTER, HeaderValue::from_static("45"));

        assert_eq!(retry_after_delay_ms(&headers), Some(45_000));
    }

    #[test]
    fn retry_delay_falls_back_to_exponential_backoff() {
        let headers = HeaderMap::new();

        assert_eq!(retry_delay_ms(0, &headers, StatusCode::BAD_GATEWAY), 500);
        assert_eq!(retry_delay_ms(1, &headers, StatusCode::BAD_GATEWAY), 1000);
        assert_eq!(retry_delay_ms(4, &headers, StatusCode::BAD_GATEWAY), 8_000);
        assert_eq!(retry_delay_ms(6, &headers, StatusCode::BAD_GATEWAY), 30_000);
        assert_eq!(retry_delay_ms(8, &headers, StatusCode::BAD_GATEWAY), 30_000);
    }

    #[test]
    fn rate_limit_retry_uses_longer_exponential_backoff() {
        let headers = HeaderMap::new();

        assert_eq!(
            retry_delay_ms(0, &headers, StatusCode::TOO_MANY_REQUESTS),
            2_000
        );
        assert_eq!(
            retry_delay_ms(1, &headers, StatusCode::TOO_MANY_REQUESTS),
            4_000
        );
        assert_eq!(
            retry_delay_ms(3, &headers, StatusCode::TOO_MANY_REQUESTS),
            16_000
        );
        assert_eq!(
            retry_delay_ms(5, &headers, StatusCode::TOO_MANY_REQUESTS),
            60_000
        );
        assert_eq!(
            retry_delay_ms(9, &headers, StatusCode::TOO_MANY_REQUESTS),
            60_000
        );
    }

    #[test]
    fn rate_limit_retry_after_never_undercuts_exponential_floor() {
        let mut headers = HeaderMap::new();
        headers.insert(RETRY_AFTER, HeaderValue::from_static("1"));

        // Retry-After: 1s must not collapse attempt 3 back to a 1s storm.
        assert_eq!(
            retry_delay_ms(3, &headers, StatusCode::TOO_MANY_REQUESTS),
            16_000
        );
    }

    #[test]
    fn rate_limit_honors_longer_retry_after() {
        let mut headers = HeaderMap::new();
        headers.insert(RETRY_AFTER, HeaderValue::from_static("45"));

        assert_eq!(
            retry_delay_ms(0, &headers, StatusCode::TOO_MANY_REQUESTS),
            45_000
        );
    }
}
