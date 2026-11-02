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

const KEENABLE_API_BASE_URL: &str = "https://api.keenable.ai";
const KEENABLE_SEARCH_TIMEOUT_SECS: u64 = 60;
const KEENABLE_APP_TITLE: &str = "OpenBitFun";

/// Keenable Search API. It works without a key through the public endpoint;
/// a saved key is sent to the keyed endpoint and only lifts rate limits.
pub struct KeenableSearchProvider {
    api_key: Option<String>,
    base_url: String,
}

impl KeenableSearchProvider {
    pub fn new(api_key: Option<String>) -> Self {
        Self {
            api_key,
            base_url: KEENABLE_API_BASE_URL.to_string(),
        }
    }

    #[cfg(test)]
    pub(super) fn with_base_url(api_key: Option<String>, base_url: impl Into<String>) -> Self {
        Self {
            api_key,
            base_url: base_url.into(),
        }
    }
}

#[derive(Serialize)]
struct KeenableRequest<'a> {
    query: &'a str,
    max_results: u32,
}

#[derive(Deserialize)]
struct KeenableResponse {
    results: Vec<KeenableResult>,
}

#[derive(Deserialize)]
struct KeenableResult {
    #[serde(default)]
    title: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    published_at: Option<serde_json::Value>,
}

#[async_trait]
impl WebSearchProvider for KeenableSearchProvider {
    fn id(&self) -> WebSearchProviderId {
        WebSearchProviderId::new(WebSearchProviderId::KEENABLE)
    }

    async fn search(&self, request: WebSearchRequest) -> Result<WebSearchResponse, WebSearchError> {
        let provider = self.id();
        validate_search_request(provider.clone(), &request)?;
        let api_key = self
            .api_key
            .as_deref()
            .map(str::trim)
            .filter(|key| !key.is_empty());
        let base_url = self.base_url.trim_end_matches('/');
        let endpoint = match api_key {
            Some(_) => format!("{base_url}/v1/search"),
            None => format!("{base_url}/v1/search/public"),
        };
        let client = search_client(provider.clone(), KEENABLE_SEARCH_TIMEOUT_SECS)?;
        let mut builder = client
            .post(endpoint)
            .header("X-Keenable-Title", KEENABLE_APP_TITLE);
        if let Some(api_key) = api_key {
            builder = builder.header("X-API-Key", api_key);
        }
        let response = builder
            .json(&KeenableRequest {
                query: &request.query,
                max_results: request.max_results,
            })
            .send()
            .await
            .map_err(|error| {
                transport_error(
                    provider.clone(),
                    "Failed to call Keenable Search API",
                    error,
                )
            })?;
        let (status, headers, body) = read_bounded_body(response, provider.clone()).await?;
        if !status.is_success() {
            return Err(classify_http_status(provider, status, &headers, &body));
        }
        let response: KeenableResponse = serde_json::from_slice(&body).map_err(|error| {
            WebSearchError::new(
                provider.clone(),
                WebSearchErrorKind::InvalidResponse,
                format!("Failed to parse Keenable response: {error}"),
            )
        })?;
        let raw_results = response
            .results
            .into_iter()
            .map(|result| WebSearchResult {
                title: result.title,
                url: result.url,
                // WebSearch exposes source metadata; WebFetch retrieves page content.
                published_at: result
                    .published_at
                    .as_ref()
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string),
                author: None,
            })
            .collect();
        let results = normalize_results(provider.clone(), raw_results, request.max_results)?;
        Ok(WebSearchResponse { provider, results })
    }
}
