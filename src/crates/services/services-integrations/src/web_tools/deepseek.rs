use super::{
    classify_http_status, normalize_results, read_bounded_body, search_client, transport_error,
    validate_search_request,
};
use async_trait::async_trait;
use openbitfun_runtime_ports::{
    WebSearchError, WebSearchErrorKind, WebSearchProvider, WebSearchProviderId, WebSearchRequest,
    WebSearchResponse, WebSearchResult,
};
use serde::{Deserialize, Serialize};

const DEEPSEEK_SEARCH_API_URL: &str = "https://api.deepseek.com/v1/tools/search";
const DEEPSEEK_SEARCH_TIMEOUT_SECS: u64 = 60;

pub struct DeepSeekSearchProvider {
    api_key: String,
    endpoint: String,
}

impl DeepSeekSearchProvider {
    pub fn new(api_key: impl Into<String>) -> Self {
        Self {
            api_key: api_key.into(),
            endpoint: DEEPSEEK_SEARCH_API_URL.to_string(),
        }
    }

    #[cfg(test)]
    pub(super) fn with_endpoint(api_key: impl Into<String>, endpoint: impl Into<String>) -> Self {
        Self {
            api_key: api_key.into(),
            endpoint: endpoint.into(),
        }
    }
}

#[derive(Serialize)]
struct DeepSeekRequest<'a> {
    query: &'a str,
    count: u32,
    need_content: bool,
}

#[derive(Deserialize)]
struct DeepSeekResponse {
    results: Vec<DeepSeekResult>,
}

#[derive(Deserialize)]
struct DeepSeekResult {
    title: String,
    url: String,
    #[serde(default)]
    date: Option<String>,
}

#[async_trait]
impl WebSearchProvider for DeepSeekSearchProvider {
    fn id(&self) -> WebSearchProviderId {
        WebSearchProviderId::new(WebSearchProviderId::DEEPSEEK)
    }

    async fn search(&self, request: WebSearchRequest) -> Result<WebSearchResponse, WebSearchError> {
        let provider = self.id();
        validate_search_request(provider.clone(), &request)?;
        if request.query.chars().count() > 128 {
            return Err(WebSearchError::new(
                provider,
                WebSearchErrorKind::InvalidRequest,
                "DeepSeek Search query must contain at most 128 Unicode characters",
            ));
        }
        if self.api_key.trim().is_empty() {
            return Err(WebSearchError::new(
                provider,
                WebSearchErrorKind::InvalidConfiguration,
                "DeepSeek API key is not configured on this device",
            ));
        }
        let client = search_client(provider.clone(), DEEPSEEK_SEARCH_TIMEOUT_SECS)?;
        let response = client
            .post(&self.endpoint)
            .bearer_auth(self.api_key.trim())
            .json(&DeepSeekRequest {
                query: &request.query,
                count: request.max_results,
                // WebSearch exposes source metadata; WebFetch retrieves page content.
                need_content: false,
            })
            .send()
            .await
            .map_err(|error| {
                transport_error(
                    provider.clone(),
                    "Failed to call DeepSeek Search API",
                    error,
                )
            })?;
        let (status, headers, body) = read_bounded_body(response, provider.clone()).await?;
        if !status.is_success() {
            let mut error = classify_http_status(provider, status, &headers, &body);
            if matches!(status.as_u16(), 408 | 504) {
                error.kind = WebSearchErrorKind::Timeout;
            }
            return Err(error);
        }
        let response: DeepSeekResponse = serde_json::from_slice(&body).map_err(|error| {
            WebSearchError::new(
                provider.clone(),
                WebSearchErrorKind::InvalidResponse,
                format!("Failed to parse DeepSeek response: {error}"),
            )
        })?;
        let raw_results = response
            .results
            .into_iter()
            .map(|result| WebSearchResult {
                title: result.title,
                url: result.url,
                published_at: result.date,
                author: None,
            })
            .collect();
        let results = normalize_results(provider.clone(), raw_results, request.max_results)?;
        Ok(WebSearchResponse { provider, results })
    }
}
