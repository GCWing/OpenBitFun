//! Network providers for built-in web tools.

mod exa_search_api;
mod openbitfun_search_http;
mod tavily;

pub use exa_search_api::ExaSearchApiProvider;
pub use openbitfun_search_http::{OpenBitFunSearchHttpAuth, OpenBitFunSearchHttpProvider};
pub use tavily::TavilySearchProvider;

use async_trait::async_trait;
use chrono::{DateTime, NaiveDate};
use openbitfun_runtime_ports::{
    WebSearchError, WebSearchErrorKind, WebSearchProvider, WebSearchProviderId, WebSearchRequest,
    WebSearchResponse, WebSearchResult,
};
use reqwest::header::{HeaderMap, CONTENT_LENGTH, RETRY_AFTER};
use reqwest::{StatusCode, Url};
use serde::Deserialize;
use serde_json::json;
use std::collections::HashSet;
use std::time::Duration;
use thiserror::Error;

const USER_AGENT_VALUE: &str = "OpenBitFun/1.0";
const WEB_FETCH_ACCEPT_VALUE: &str =
    "text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5";
const WEB_FETCH_ACCEPT_LANGUAGE_VALUE: &str = "en-US,en;q=0.9";
const WEB_FETCH_TIMEOUT_SECS: u64 = 30;
const EXA_URL: &str = "https://mcp.exa.ai/mcp";
const EXA_TIMEOUT_SECS: u64 = 60;
pub(crate) const SEARCH_RESPONSE_BODY_LIMIT_BYTES: usize = 1024 * 1024;
pub(crate) const SEARCH_ERROR_MESSAGE_LIMIT_CHARS: usize = 500;
const SEARCH_TITLE_LIMIT_CHARS: usize = 512;
const SEARCH_URL_LIMIT_CHARS: usize = 8192;
const SEARCH_METADATA_LIMIT_CHARS: usize = 512;

#[derive(Debug, Error)]
pub enum WebToolNetworkError {
    #[error("Failed to create HTTP client: {0}")]
    BuildClient(String),
    #[error("Failed to fetch URL: {0}")]
    Fetch(String),
    #[error("HTTP error {status}: {reason}")]
    HttpStatus {
        status_code: u16,
        status: String,
        reason: String,
        retry_after: Option<String>,
        rate_limit_remaining: Option<String>,
        rate_limit_reset: Option<String>,
    },
    #[error("Failed to read response: {0}")]
    ReadResponse(String),
    #[error("Failed to send request: {0}")]
    SearchRequest(String),
    #[error("Web search error {status}: {body}")]
    SearchStatus { status: String, body: String },
    #[error("Exa authentication failed: {message}")]
    SearchAuthentication { message: String },
    #[error("Exa credits or search quota exhausted: {message}")]
    SearchQuota { message: String },
    #[error("Exa search request is not permitted: {message}")]
    SearchPermission { message: String },
    #[error("Exa search rate limit exceeded: {message}")]
    SearchRateLimited { message: String },
    #[error("Exa MCP tool error: {message}")]
    SearchTool { message: String },
    #[error("Exa MCP protocol error {code}: {message}")]
    SearchProtocol { code: i64, message: String },
    #[error("Web search returned no content")]
    SearchEmpty,
}

#[derive(Debug, Clone)]
pub struct WebFetchResponse {
    pub content_type: Option<String>,
    pub content: String,
}

#[derive(Debug, Deserialize)]
struct ExaResponse {
    result: Option<ExaData>,
    error: Option<ExaRpcError>,
}

#[derive(Debug, Deserialize)]
struct ExaData {
    #[serde(default)]
    content: Vec<ExaContent>,
    #[serde(rename = "isError", default)]
    is_error: bool,
}

#[derive(Debug, Deserialize)]
struct ExaRpcError {
    code: i64,
    message: String,
}

#[derive(Debug, Deserialize)]
struct ExaContent {
    #[serde(rename = "type")]
    kind: String,
    text: Option<String>,
}

pub struct WebToolNetworkProvider;

#[derive(Debug, Clone, Default)]
pub struct FreeExaMcpProvider;

#[async_trait]
impl WebSearchProvider for FreeExaMcpProvider {
    fn id(&self) -> WebSearchProviderId {
        WebSearchProviderId::new(WebSearchProviderId::EXA_MCP_FREE)
    }

    async fn search(&self, request: WebSearchRequest) -> Result<WebSearchResponse, WebSearchError> {
        let provider = self.id();
        validate_search_request(provider.clone(), &request)?;
        let client = search_client(provider.clone(), EXA_TIMEOUT_SECS)?;
        let response = client
            .post(EXA_URL)
            .header("accept", "application/json, text/event-stream")
            .json(&build_exa_request_body(&request.query, request.max_results))
            .send()
            .await
            .map_err(|error| {
                transport_error(provider.clone(), "Failed to call free Exa MCP", error)
            })?;
        let (status, headers, body) = read_bounded_body(response, provider.clone()).await?;
        if !status.is_success() {
            return Err(classify_http_status(provider, status, &headers, &body));
        }
        let text = std::str::from_utf8(&body).map_err(|error| {
            WebSearchError::new(
                provider.clone(),
                WebSearchErrorKind::InvalidResponse,
                format!("Free Exa MCP response was not valid UTF-8: {error}"),
            )
        })?;
        let text =
            parse_exa_sse(text).map_err(|error| map_legacy_exa_error(provider.clone(), error))?;
        let raw_results = parse_exa_text_results(&text);
        let results = normalize_results(provider.clone(), raw_results, request.max_results)?;
        Ok(WebSearchResponse { provider, results })
    }
}

pub(crate) fn validate_search_request(
    provider: WebSearchProviderId,
    request: &WebSearchRequest,
) -> Result<(), WebSearchError> {
    if request.query.trim().is_empty() {
        return Err(WebSearchError::new(
            provider,
            WebSearchErrorKind::InvalidRequest,
            "Web search query cannot be empty",
        ));
    }
    if !(1..=20).contains(&request.max_results) {
        return Err(WebSearchError::new(
            provider,
            WebSearchErrorKind::InvalidRequest,
            "Web search maxResults must be between 1 and 20",
        ));
    }
    Ok(())
}

impl WebToolNetworkProvider {
    pub async fn fetch_text(url: &str) -> Result<WebFetchResponse, WebToolNetworkError> {
        let client = crate::reqwest_client_builder()
            .user_agent(USER_AGENT_VALUE)
            .timeout(Duration::from_secs(WEB_FETCH_TIMEOUT_SECS))
            .build()
            .map_err(|error| WebToolNetworkError::BuildClient(error.to_string()))?;

        let response = client
            .get(url)
            .header(reqwest::header::ACCEPT, WEB_FETCH_ACCEPT_VALUE)
            .header(
                reqwest::header::ACCEPT_LANGUAGE,
                WEB_FETCH_ACCEPT_LANGUAGE_VALUE,
            )
            .send()
            .await
            .map_err(|error| WebToolNetworkError::Fetch(error.to_string()))?;

        if !response.status().is_success() {
            let status = response.status();
            return Err(WebToolNetworkError::HttpStatus {
                status_code: status.as_u16(),
                status: status.to_string(),
                reason: status
                    .canonical_reason()
                    .unwrap_or("Unknown error")
                    .to_string(),
                retry_after: response_header(&response, reqwest::header::RETRY_AFTER),
                rate_limit_remaining: response_header_name(&response, "x-ratelimit-remaining"),
                rate_limit_reset: response_header_name(&response, "x-ratelimit-reset"),
            });
        }

        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);

        let content = response
            .text()
            .await
            .map_err(|error| WebToolNetworkError::ReadResponse(error.to_string()))?;

        Ok(WebFetchResponse {
            content_type,
            content,
        })
    }
}

fn build_exa_request_body(query: &str, max_results: u32) -> serde_json::Value {
    json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": "web_search_exa",
            "arguments": {
                "query": query,
                "numResults": max_results,
            }
        }
    })
}

fn parse_exa_sse(text: &str) -> Result<String, WebToolNetworkError> {
    for payload in text.lines().filter_map(|line| line.strip_prefix("data: ")) {
        if let Ok(response) = serde_json::from_str::<ExaResponse>(payload) {
            if let Some(result) = parse_exa_response(response) {
                return result;
            }
        }
    }

    if let Ok(response) = serde_json::from_str::<ExaResponse>(text.trim()) {
        if let Some(result) = parse_exa_response(response) {
            return result;
        }
    }

    Err(WebToolNetworkError::SearchEmpty)
}

fn parse_exa_response(response: ExaResponse) -> Option<Result<String, WebToolNetworkError>> {
    if let Some(error) = response.error {
        let message = bounded_error_message(&error.message);
        return Some(Err(classify_known_exa_error(&message).unwrap_or(
            WebToolNetworkError::SearchProtocol {
                code: error.code,
                message,
            },
        )));
    }

    let result = response.result?;
    let text = result
        .content
        .into_iter()
        .filter(|item| item.kind == "text")
        .filter_map(|item| item.text)
        .collect::<Vec<_>>()
        .join("\n");

    if result.is_error {
        let message = if text.trim().is_empty() {
            "Unknown Exa MCP tool error".to_string()
        } else {
            bounded_error_message(&text)
        };
        return Some(Err(classify_known_exa_error(&message)
            .unwrap_or(WebToolNetworkError::SearchTool { message })));
    }

    (!text.trim().is_empty()).then_some(Ok(text))
}

fn classify_known_exa_error(message: &str) -> Option<WebToolNetworkError> {
    let lower = message.to_ascii_lowercase();
    if lower.contains("(429)")
        || lower.contains("rate limit")
        || lower.contains("too many requests")
    {
        return Some(WebToolNetworkError::SearchRateLimited {
            message: message.to_string(),
        });
    }
    if lower.contains("(401)")
        || lower.contains("invalid api key")
        || lower.contains("api key is invalid")
        || lower.contains("unauthorized")
        || lower.contains("authentication failed")
    {
        return Some(WebToolNetworkError::SearchAuthentication {
            message: message.to_string(),
        });
    }
    if lower.contains("(402)")
        || lower.contains("credit")
        || lower.contains("quota")
        || lower.contains("budget")
        || lower.contains("insufficient balance")
    {
        return Some(WebToolNetworkError::SearchQuota {
            message: message.to_string(),
        });
    }
    if lower.contains("(403)") || lower.contains("forbidden") || lower.contains("permission") {
        return Some(WebToolNetworkError::SearchPermission {
            message: message.to_string(),
        });
    }
    None
}

fn bounded_error_message(message: &str) -> String {
    let message = message.trim();
    if message.chars().count() <= SEARCH_ERROR_MESSAGE_LIMIT_CHARS {
        return message.to_string();
    }

    let mut bounded = message
        .chars()
        .take(SEARCH_ERROR_MESSAGE_LIMIT_CHARS - 3)
        .collect::<String>();
    bounded.push_str("...");
    bounded
}

fn map_legacy_exa_error(
    provider: WebSearchProviderId,
    error: WebToolNetworkError,
) -> WebSearchError {
    let kind = match &error {
        WebToolNetworkError::SearchAuthentication { .. } => WebSearchErrorKind::Authentication,
        WebToolNetworkError::SearchQuota { .. } => WebSearchErrorKind::QuotaExhausted,
        WebToolNetworkError::SearchPermission { .. } => WebSearchErrorKind::PermissionDenied,
        WebToolNetworkError::SearchRateLimited { .. } => WebSearchErrorKind::RateLimited,
        WebToolNetworkError::SearchProtocol { .. }
        | WebToolNetworkError::SearchTool { .. }
        | WebToolNetworkError::SearchEmpty => WebSearchErrorKind::InvalidResponse,
        WebToolNetworkError::SearchRequest(ref message) if is_timeout_message(message) => {
            WebSearchErrorKind::Timeout
        }
        WebToolNetworkError::BuildClient(_)
        | WebToolNetworkError::SearchRequest(_)
        | WebToolNetworkError::SearchStatus { .. }
        | WebToolNetworkError::ReadResponse(_) => WebSearchErrorKind::Transport,
        WebToolNetworkError::Fetch(_) | WebToolNetworkError::HttpStatus { .. } => {
            WebSearchErrorKind::Transport
        }
    };
    WebSearchError::new(provider, kind, bounded_error_message(&error.to_string()))
}

fn is_timeout_message(message: &str) -> bool {
    message.to_ascii_lowercase().contains("timed out")
        || message.to_ascii_lowercase().contains("timeout")
}

fn parse_exa_text_results(text: &str) -> Vec<WebSearchResult> {
    let mut output = Vec::new();
    let mut current: Option<WebSearchResult> = None;

    for line in text.lines() {
        if let Some(title) = line.strip_prefix("Title: ") {
            if let Some(result) = current.take() {
                output.push(result);
            }
            current = Some(WebSearchResult {
                title: title.trim().to_string(),
                url: String::new(),
                published_at: None,
                author: None,
            });
            continue;
        }

        let Some(result) = current.as_mut() else {
            continue;
        };
        if let Some(url) = line.strip_prefix("URL: ") {
            result.url = url.trim().to_string();
        } else if let Some(published_at) = line
            .strip_prefix("Published: ")
            .or_else(|| line.strip_prefix("Published Date: "))
        {
            result.published_at = Some(published_at.trim().to_string());
        } else if let Some(author) = line.strip_prefix("Author: ") {
            result.author = Some(author.trim().to_string());
        }
    }
    if let Some(result) = current {
        output.push(result);
    }
    output
}

pub(crate) fn normalize_results(
    provider: WebSearchProviderId,
    raw_results: Vec<WebSearchResult>,
    max_results: u32,
) -> Result<Vec<WebSearchResult>, WebSearchError> {
    let had_results = !raw_results.is_empty();
    let mut seen_urls = HashSet::new();
    let mut results = Vec::new();

    for raw in raw_results {
        let title = bounded_nonempty(&raw.title, SEARCH_TITLE_LIMIT_CHARS);
        let Some(title) = title else {
            continue;
        };
        let Some(url) = normalize_http_url(&raw.url) else {
            continue;
        };
        if !seen_urls.insert(url.clone()) {
            continue;
        }
        results.push(WebSearchResult {
            title,
            url,
            published_at: normalize_published_at(raw.published_at.as_deref()),
            author: normalize_optional_text(raw.author.as_deref()),
        });
        if results.len() >= max_results as usize {
            break;
        }
    }

    if had_results && results.is_empty() {
        return Err(WebSearchError::new(
            provider,
            WebSearchErrorKind::InvalidResponse,
            "Web search response contained no valid title and HTTP(S) URL pairs",
        ));
    }
    Ok(results)
}

fn bounded_nonempty(value: &str, limit: usize) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    Some(value.chars().take(limit).collect())
}

fn normalize_http_url(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > SEARCH_URL_LIMIT_CHARS {
        return None;
    }
    let url = Url::parse(value).ok()?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return None;
    }
    Some(url.to_string())
}

fn normalize_optional_text(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    if value.is_empty() || value.eq_ignore_ascii_case("n/a") || value.eq_ignore_ascii_case("null") {
        return None;
    }
    Some(value.chars().take(SEARCH_METADATA_LIMIT_CHARS).collect())
}

fn normalize_published_at(value: Option<&str>) -> Option<String> {
    let value = normalize_optional_text(value)?;
    if let Ok(date_time) = DateTime::parse_from_rfc3339(&value) {
        return Some(date_time.to_rfc3339());
    }
    if NaiveDate::parse_from_str(&value, "%Y-%m-%d").is_ok() {
        return Some(value);
    }
    None
}

pub(crate) fn search_client(
    provider: WebSearchProviderId,
    timeout_secs: u64,
) -> Result<reqwest::Client, WebSearchError> {
    crate::reqwest_client_builder()
        .user_agent(USER_AGENT_VALUE)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(timeout_secs))
        .build()
        .map_err(|error| {
            WebSearchError::new(
                provider,
                WebSearchErrorKind::InvalidConfiguration,
                format!("Failed to create web search HTTP client: {error}"),
            )
        })
}

pub(crate) async fn read_bounded_body(
    mut response: reqwest::Response,
    provider: WebSearchProviderId,
) -> Result<(StatusCode, HeaderMap, Vec<u8>), WebSearchError> {
    let status = response.status();
    let headers = response.headers().clone();
    if headers
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|length| length > SEARCH_RESPONSE_BODY_LIMIT_BYTES)
    {
        return Err(WebSearchError::new(
            provider,
            WebSearchErrorKind::InvalidResponse,
            "Web search response exceeded the 1 MiB limit",
        ));
    }

    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| {
        transport_error(
            provider.clone(),
            "Failed to read web search response",
            error,
        )
    })? {
        if body.len().saturating_add(chunk.len()) > SEARCH_RESPONSE_BODY_LIMIT_BYTES {
            return Err(WebSearchError::new(
                provider,
                WebSearchErrorKind::InvalidResponse,
                "Web search response exceeded the 1 MiB limit",
            ));
        }
        body.extend_from_slice(&chunk);
    }
    Ok((status, headers, body))
}

pub(crate) fn transport_error(
    provider: WebSearchProviderId,
    context: &str,
    error: reqwest::Error,
) -> WebSearchError {
    let kind = if error.is_timeout() {
        WebSearchErrorKind::Timeout
    } else {
        WebSearchErrorKind::Transport
    };
    WebSearchError::new(provider, kind, format!("{context}: {error}"))
}

pub(crate) fn retry_after_seconds(headers: &HeaderMap) -> Option<u64> {
    headers
        .get(RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
}

pub(crate) fn extract_error_message(body: &[u8]) -> String {
    let value = serde_json::from_slice::<serde_json::Value>(body).ok();
    let message = value
        .as_ref()
        .and_then(|value| {
            value
                .pointer("/detail/error")
                .or_else(|| value.pointer("/error/message"))
                .or_else(|| value.get("error"))
                .or_else(|| value.get("message"))
        })
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| String::from_utf8_lossy(body).trim().to_string());
    if message.is_empty() {
        "Unknown provider error".to_string()
    } else {
        bounded_error_message(&message)
    }
}

pub(crate) fn classify_http_status(
    provider: WebSearchProviderId,
    status: StatusCode,
    headers: &HeaderMap,
    body: &[u8],
) -> WebSearchError {
    let kind = match status.as_u16() {
        400 | 422 => WebSearchErrorKind::InvalidRequest,
        401 => WebSearchErrorKind::Authentication,
        402 | 432 | 433 => WebSearchErrorKind::QuotaExhausted,
        403 => WebSearchErrorKind::PermissionDenied,
        429 => WebSearchErrorKind::RateLimited,
        500..=599 => WebSearchErrorKind::ProviderUnavailable,
        _ => WebSearchErrorKind::Transport,
    };
    WebSearchError::new(provider, kind, extract_error_message(body))
        .with_retry_after_seconds(retry_after_seconds(headers))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    async fn serve_once(response: String) -> (String, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind WebSearch fixture server");
        let address = listener.local_addr().expect("fixture server address");
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept fixture request");
            let mut request = Vec::new();
            let mut buffer = [0u8; 4096];
            loop {
                let count = socket
                    .read(&mut buffer)
                    .await
                    .expect("read fixture request");
                if count == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..count]);
                let header_end = request
                    .windows(4)
                    .position(|window| window == b"\r\n\r\n")
                    .map(|index| index + 4);
                let Some(header_end) = header_end else {
                    continue;
                };
                let headers = String::from_utf8_lossy(&request[..header_end]);
                let content_length = headers
                    .lines()
                    .find_map(|line| {
                        line.split_once(':').and_then(|(name, value)| {
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().ok())
                                .flatten()
                        })
                    })
                    .unwrap_or(0);
                if request.len() >= header_end + content_length {
                    break;
                }
            }
            socket
                .write_all(response.as_bytes())
                .await
                .expect("write fixture response");
            String::from_utf8(request).expect("fixture request should be UTF-8")
        });
        (format!("http://{address}/search"), task)
    }

    fn json_response(body: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
    }

    #[test]
    fn exa_request_contains_only_supported_arguments() {
        let body = build_exa_request_body("example query", 10);

        assert_eq!(
            body["params"]["arguments"],
            json!({
                "query": "example query",
                "numResults": 10,
            })
        );
    }

    #[test]
    fn parse_exa_sse_returns_first_text_payload() {
        let text = concat!(
            "event: message\n",
            "data: {\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"Title: A\\nURL: https://example.com\"}]}}\n",
            "\n"
        );

        let out = parse_exa_sse(text).expect("exa text should parse");

        assert_eq!(out, "Title: A\nURL: https://example.com");
    }

    #[test]
    fn parse_exa_sse_rejects_empty_text_payload() {
        let text = "data: {\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"   \"}]}}\n";

        let error = parse_exa_sse(text).unwrap_err();

        assert!(matches!(error, WebToolNetworkError::SearchEmpty));
    }

    #[test]
    fn parse_exa_sse_rejects_mcp_tool_authentication_error() {
        let text = "data: {\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"web_search_exa error (401): Invalid API key\"}],\"isError\":true}}\n";

        let error = parse_exa_sse(text).unwrap_err();

        assert!(matches!(
            error,
            WebToolNetworkError::SearchAuthentication { .. }
        ));
    }

    #[test]
    fn parse_exa_sse_rejects_mcp_tool_rate_limit_error() {
        let text = "data: {\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"Free MCP rate limit reached; provide your own Exa API key\"}],\"isError\":true}}\n";

        let error = parse_exa_sse(text).unwrap_err();

        assert!(matches!(
            error,
            WebToolNetworkError::SearchRateLimited { .. }
        ));
    }

    #[test]
    fn parse_exa_sse_rejects_json_rpc_error() {
        let text = "data: {\"error\":{\"code\":-32000,\"message\":\"Provider unavailable\"}}\n";

        let error = parse_exa_sse(text).unwrap_err();

        assert!(matches!(
            error,
            WebToolNetworkError::SearchProtocol { code: -32000, .. }
        ));
    }

    #[test]
    fn normalizes_search_results_without_reordering() {
        let provider = WebSearchProviderId::new(WebSearchProviderId::TAVILY);
        let results = normalize_results(
            provider,
            vec![
                WebSearchResult {
                    title: " First ".to_string(),
                    url: "https://example.com/a".to_string(),
                    published_at: Some("2026-08-30".to_string()),
                    author: Some(" Author ".to_string()),
                },
                WebSearchResult {
                    title: "Duplicate".to_string(),
                    url: "https://example.com/a".to_string(),
                    published_at: None,
                    author: None,
                },
                WebSearchResult {
                    title: "Invalid".to_string(),
                    url: "file:///tmp/result".to_string(),
                    published_at: None,
                    author: None,
                },
                WebSearchResult {
                    title: "Second".to_string(),
                    url: "https://example.com/b".to_string(),
                    published_at: Some("N/A".to_string()),
                    author: Some("N/A".to_string()),
                },
            ],
            10,
        )
        .expect("valid results should normalize");

        assert_eq!(results.len(), 2);
        assert_eq!(results[0].title, "First");
        assert_eq!(results[0].author.as_deref(), Some("Author"));
        assert_eq!(results[1].title, "Second");
        assert!(results[1].published_at.is_none());
        assert!(results[1].author.is_none());
    }

    #[tokio::test]
    async fn exa_search_api_uses_exact_body_and_key_header() {
        let response_body = r#"{"requestId":"request-1","results":[{"title":"One","url":"https://example.com/one","publishedDate":"2026-08-30","author":"A"}]}"#;
        let (endpoint, request_task) = serve_once(json_response(response_body)).await;
        let provider = ExaSearchApiProvider::with_endpoint("exa-secret", endpoint);

        let response = provider
            .search(WebSearchRequest {
                query: "rust async".to_string(),
                max_results: 3,
            })
            .await
            .expect("Exa fixture search should succeed");
        let request = request_task.await.expect("Exa fixture request task");
        let request_lower = request.to_ascii_lowercase();

        assert!(request_lower.contains("x-api-key: exa-secret"));
        assert!(request.ends_with(r#"{"query":"rust async","numResults":3}"#));
        assert_eq!(response.provider.as_str(), "exa_search_api");
        assert_eq!(response.results[0].author.as_deref(), Some("A"));
    }

    #[tokio::test]
    async fn exa_search_api_preserves_error_request_id() {
        let response_body = r#"{"requestId":"exa-request-401","error":"invalid key"}"#;
        let (endpoint, request_task) = serve_once(format!(
            "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            response_body.len(),
            response_body
        ))
        .await;
        let provider = ExaSearchApiProvider::with_endpoint("bad-key", endpoint);

        let error = provider
            .search(WebSearchRequest {
                query: "auth".to_string(),
                max_results: 1,
            })
            .await
            .expect_err("authentication error should be mapped");
        request_task.await.expect("Exa error fixture request task");

        assert_eq!(error.kind, WebSearchErrorKind::Authentication);
        assert_eq!(error.request_id.as_deref(), Some("exa-request-401"));
    }

    #[tokio::test]
    async fn tavily_uses_bearer_and_provider_neutral_result_fields() {
        let response_body = r#"{"results":[{"title":"One","url":"https://example.com/one","content":"ignored","score":0.9}]}"#;
        let (endpoint, request_task) = serve_once(json_response(response_body)).await;
        let provider = TavilySearchProvider::with_endpoint("tvly-secret", endpoint);

        let response = provider
            .search(WebSearchRequest {
                query: "rust async".to_string(),
                max_results: 4,
            })
            .await
            .expect("Tavily fixture search should succeed");
        let request = request_task.await.expect("Tavily fixture request task");
        let request_lower = request.to_ascii_lowercase();

        assert!(request_lower.contains("authorization: bearer tvly-secret"));
        assert!(request.ends_with(r#"{"query":"rust async","max_results":4}"#));
        assert!(response.results[0].published_at.is_none());
        assert!(response.results[0].author.is_none());
    }

    #[tokio::test]
    async fn openbitfun_http_protocol_uses_v1_media_type_and_camel_case_body() {
        let response_body = r#"{"results":[{"title":"One","url":"https://example.com/one","publishedAt":"2026-08-30T00:00:00Z","author":"A"}]}"#;
        let (endpoint, request_task) = serve_once(format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/vnd.openbitfun.web-search.v1+json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            response_body.len(),
            response_body
        ))
        .await;
        let provider = OpenBitFunSearchHttpProvider::new(
            endpoint,
            OpenBitFunSearchHttpAuth::Header {
                name: "X-Search-Key".to_string(),
                value: "http-secret".to_string(),
            },
        )
        .expect("loopback endpoint should be valid");

        let response = provider
            .search(WebSearchRequest {
                query: "rust async".to_string(),
                max_results: 5,
            })
            .await
            .expect("OpenBitFun HTTP fixture search should succeed");
        let request = request_task
            .await
            .expect("OpenBitFun HTTP fixture request task");
        let request_lower = request.to_ascii_lowercase();

        assert!(request_lower.contains("accept: application/vnd.openbitfun.web-search.v1+json"));
        assert!(request_lower.contains("x-search-key: http-secret"));
        assert!(request.ends_with(r#"{"query":"rust async","maxResults":5}"#));
        assert_eq!(response.provider.as_str(), "openbitfun_search_http");
    }

    #[test]
    fn openbitfun_http_protocol_rejects_unsafe_endpoint_and_managed_headers() {
        assert!(OpenBitFunSearchHttpProvider::new(
            "http://example.com/search",
            OpenBitFunSearchHttpAuth::None
        )
        .is_err());
        assert!(OpenBitFunSearchHttpProvider::new(
            "https://example.com/search",
            OpenBitFunSearchHttpAuth::Header {
                name: "Authorization".to_string(),
                value: "secret".to_string(),
            }
        )
        .is_err());
    }

    #[tokio::test]
    async fn openbitfun_http_protocol_does_not_follow_redirects() {
        let (endpoint, request_task) = serve_once(
            "HTTP/1.1 302 Found\r\nLocation: https://example.com/other\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                .to_string(),
        )
        .await;
        let provider = OpenBitFunSearchHttpProvider::new(endpoint, OpenBitFunSearchHttpAuth::None)
            .expect("loopback endpoint should be valid");

        let error = provider
            .search(WebSearchRequest {
                query: "redirect".to_string(),
                max_results: 1,
            })
            .await
            .expect_err("redirect should not be followed");
        request_task.await.expect("redirect fixture request task");
        assert_eq!(error.kind, WebSearchErrorKind::Transport);
    }

    #[tokio::test]
    async fn openbitfun_http_protocol_maps_error_envelope_code_and_retry_after() {
        let response_body =
            r#"{"error":{"code":"rate_limited","message":"Slow down","retryAfterSeconds":17}}"#;
        let (endpoint, request_task) = serve_once(format!(
            "HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/vnd.openbitfun.web-search.v1+json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            response_body.len(),
            response_body
        ))
        .await;
        let provider = OpenBitFunSearchHttpProvider::new(endpoint, OpenBitFunSearchHttpAuth::None)
            .expect("loopback endpoint should be valid");

        let error = provider
            .search(WebSearchRequest {
                query: "limited".to_string(),
                max_results: 1,
            })
            .await
            .expect_err("protocol error envelope should be mapped");
        request_task
            .await
            .expect("OpenBitFun error fixture request task");

        assert_eq!(error.kind, WebSearchErrorKind::RateLimited);
        assert_eq!(error.message, "Slow down");
        assert_eq!(error.retry_after_seconds, Some(17));
    }

    #[tokio::test]
    async fn web_search_response_body_limit_is_enforced_from_content_length() {
        let (endpoint, request_task) = serve_once(format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            SEARCH_RESPONSE_BODY_LIMIT_BYTES + 1
        ))
        .await;
        let provider = TavilySearchProvider::with_endpoint("tvly-secret", endpoint);

        let error = provider
            .search(WebSearchRequest {
                query: "large".to_string(),
                max_results: 1,
            })
            .await
            .expect_err("oversized response should fail");
        request_task.await.expect("large fixture request task");
        assert_eq!(error.kind, WebSearchErrorKind::InvalidResponse);
    }
}

fn response_header(
    response: &reqwest::Response,
    name: reqwest::header::HeaderName,
) -> Option<String> {
    response
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}

fn response_header_name(response: &reqwest::Response, name: &str) -> Option<String> {
    response
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}
