use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::fmt;

/// Stable identifier for the backend that actually executed a web search.
///
/// This is a string newtype rather than a closed enum so persisted results from
/// a newer OpenBitFun build remain readable by older code.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct WebSearchProviderId(String);

impl WebSearchProviderId {
    pub const EXA_MCP_FREE: &'static str = "exa_mcp_free";
    pub const EXA_SEARCH_API: &'static str = "exa_search_api";
    pub const TAVILY: &'static str = "tavily";
    pub const DEEPSEEK: &'static str = "deepseek";
    pub const OPENBITFUN_SEARCH_HTTP: &'static str = "openbitfun_search_http";

    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for WebSearchProviderId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchRequest {
    pub query: String,
    pub max_results: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchResult {
    pub title: String,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub published_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchResponse {
    pub provider: WebSearchProviderId,
    pub results: Vec<WebSearchResult>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WebSearchErrorKind {
    InvalidConfiguration,
    InvalidRequest,
    Authentication,
    PermissionDenied,
    QuotaExhausted,
    RateLimited,
    Timeout,
    Transport,
    ProviderUnavailable,
    InvalidResponse,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchError {
    pub provider: WebSearchProviderId,
    pub kind: WebSearchErrorKind,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_after_seconds: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

impl WebSearchError {
    pub fn new(
        provider: WebSearchProviderId,
        kind: WebSearchErrorKind,
        message: impl Into<String>,
    ) -> Self {
        Self {
            provider,
            kind,
            message: message.into(),
            retry_after_seconds: None,
            request_id: None,
        }
    }

    pub fn with_retry_after_seconds(mut self, retry_after_seconds: Option<u64>) -> Self {
        self.retry_after_seconds = retry_after_seconds;
        self
    }

    pub fn with_request_id(mut self, request_id: Option<String>) -> Self {
        self.request_id = request_id;
        self
    }
}

impl fmt::Display for WebSearchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Web search provider {}: {}", self.provider, self.message)
    }
}

impl std::error::Error for WebSearchError {}

#[async_trait]
pub trait WebSearchProvider: Send + Sync {
    fn id(&self) -> WebSearchProviderId;

    async fn search(&self, request: WebSearchRequest) -> Result<WebSearchResponse, WebSearchError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn response_omits_absent_optional_metadata() {
        let value = serde_json::to_value(WebSearchResponse {
            provider: WebSearchProviderId::new(WebSearchProviderId::TAVILY),
            results: vec![WebSearchResult {
                title: "Result".to_string(),
                url: "https://example.com".to_string(),
                published_at: None,
                author: None,
            }],
        })
        .unwrap();

        assert_eq!(value["provider"], "tavily");
        assert!(value["results"][0].get("publishedAt").is_none());
        assert!(value["results"][0].get("author").is_none());
    }

    #[test]
    fn provider_id_preserves_unknown_values() {
        let provider: WebSearchProviderId = serde_json::from_str("\"future_provider\"").unwrap();
        assert_eq!(provider.as_str(), "future_provider");
    }
}
