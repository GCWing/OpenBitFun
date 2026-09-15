use crate::account_identity::{
    AccountIdentityClient, DesktopAuthPollRequest, DesktopAuthPollResponse, DesktopAuthStart,
    MarketClientError, MarketMe,
};
use openbitfun_product_domains::miniapp::market::{
    CursorPage, MarketListingDetail, MarketListingSummary, MarketSort, MarketSubmission,
    MarketSubmissionDraftRequest, ReviewDecisionRequest, MARKET_PACKAGE_CONTENT_TYPE,
};
use reqwest::{Method, RequestBuilder, Response};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

const DEFAULT_MARKET_API_URL: &str = "https://market.openbitfun.com/miniapp/api/v1";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketBrowseRequest {
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub sort: MarketSort,
    pub cursor: Option<String>,
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RatingAggregate {
    pub average: f64,
    pub count: u32,
    pub my_rating: Option<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FavoriteAggregate {
    pub count: u32,
    pub is_favorited: bool,
}

#[derive(Debug, Deserialize)]
struct ErrorEnvelope {
    error: ErrorBody,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ErrorBody {
    code: String,
    message: String,
    request_id: Option<String>,
}

#[derive(Debug)]
pub struct MarketClient {
    base_url: String,
    client: reqwest::Client,
    identity: AccountIdentityClient,
}

impl MarketClient {
    pub fn configured_base_url() -> String {
        std::env::var("OPENBITFUN_MINIAPP_MARKET_API_URL")
            .unwrap_or_else(|_| DEFAULT_MARKET_API_URL.to_string())
    }

    pub async fn from_environment() -> Result<Self, MarketClientError> {
        let mut client = Self::new(Self::configured_base_url()).await?;
        client.identity = AccountIdentityClient::from_environment().await?;
        Ok(client)
    }

    pub async fn new(base_url: impl Into<String>) -> Result<Self, MarketClientError> {
        let base_url = base_url.into().trim_end_matches('/').to_string();
        let parsed = reqwest::Url::parse(&base_url)
            .map_err(|error| local_error("invalid_market_url", error.to_string()))?;
        let local_http = parsed.scheme() == "http"
            && parsed
                .host_str()
                .is_some_and(|host| matches!(host, "127.0.0.1" | "localhost" | "::1"));
        if parsed.scheme() != "https" && !local_http {
            return Err(local_error(
                "invalid_market_url",
                "The MiniApp market API must use HTTPS.",
            ));
        }
        let client = crate::reqwest_client_builder()
            .user_agent(format!("OpenBitFun-Desktop/{}", env!("CARGO_PKG_VERSION")))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| local_error("market_client_init_failed", error.to_string()))?;
        let identity = AccountIdentityClient::new(base_url.clone()).await?;
        Ok(Self {
            base_url,
            client,
            identity,
        })
    }

    pub async fn browse(
        &self,
        request: &MarketBrowseRequest,
    ) -> Result<CursorPage<MarketListingSummary>, MarketClientError> {
        let mut query = vec![
            ("sort", market_sort_value(request.sort).to_string()),
            ("limit", request.limit.unwrap_or(20).to_string()),
        ];
        if !request.query.trim().is_empty() {
            query.push(("q", request.query.trim().to_string()));
        }
        if !request.category.trim().is_empty() && request.category != "all" {
            query.push(("category", request.category.trim().to_string()));
        }
        if let Some(cursor) = request.cursor.as_ref().filter(|value| !value.is_empty()) {
            query.push(("cursor", cursor.clone()));
        }
        self.json(self.client.get(self.url("/listings")).query(&query))
            .await
    }

    pub async fn listing(&mut self, slug: &str) -> Result<MarketListingDetail, MarketClientError> {
        let token = self.identity.access_token().await?;
        let request = self
            .client
            .get(self.url(&format!("/listings/{}", urlencoding::encode(slug))));
        self.json(match token {
            Some(token) => request.bearer_auth(token),
            None => request,
        })
        .await
    }

    pub async fn download_release(
        &self,
        slug: &str,
        release_number: u32,
    ) -> Result<Vec<u8>, MarketClientError> {
        let response = self
            .client
            .get(self.url(&format!(
                "/listings/{}/releases/{release_number}/download",
                urlencoding::encode(slug)
            )))
            .send()
            .await
            .map_err(transport_error)?;
        let response = checked_response(response).await?;
        let bytes = response.bytes().await.map_err(transport_error)?;
        Ok(bytes.to_vec())
    }

    pub async fn start_desktop_auth(&self) -> Result<DesktopAuthStart, MarketClientError> {
        self.identity.start_desktop_auth().await
    }

    pub async fn poll_desktop_auth(
        &mut self,
        request: &DesktopAuthPollRequest,
    ) -> Result<DesktopAuthPollResponse, MarketClientError> {
        self.identity.poll_desktop_auth(request).await
    }

    pub async fn me(&mut self) -> Result<Option<MarketMe>, MarketClientError> {
        self.identity.me().await
    }

    pub async fn set_rating(
        &mut self,
        slug: &str,
        value: Option<u8>,
    ) -> Result<RatingAggregate, MarketClientError> {
        let request = self
            .authorized(self.client.request(
                if value.is_some() {
                    Method::PUT
                } else {
                    Method::DELETE
                },
                self.url(&format!("/listings/{}/rating", urlencoding::encode(slug))),
            ))
            .await?;
        self.json(match value {
            Some(value) => request.json(&serde_json::json!({ "value": value })),
            None => request,
        })
        .await
    }

    pub async fn set_favorite(
        &mut self,
        slug: &str,
        enabled: bool,
    ) -> Result<FavoriteAggregate, MarketClientError> {
        let request = self
            .authorized(self.client.request(
                if enabled { Method::PUT } else { Method::DELETE },
                self.url(&format!("/listings/{}/favorite", urlencoding::encode(slug))),
            ))
            .await?;
        self.json(request).await
    }

    pub async fn list_submissions(&mut self) -> Result<Vec<MarketSubmission>, MarketClientError> {
        let request = self
            .authorized(self.client.get(self.url("/submissions")))
            .await?;
        let page: CursorPage<MarketSubmission> = self.json(request).await?;
        Ok(page.items)
    }

    pub async fn withdraw_submission(
        &mut self,
        submission_id: &str,
    ) -> Result<MarketSubmission, MarketClientError> {
        let request = self
            .authorized(self.client.delete(self.url(&format!(
                "/submissions/{}",
                urlencoding::encode(submission_id)
            ))))
            .await?;
        self.json(request).await
    }

    pub async fn create_submission(
        &mut self,
        draft: &MarketSubmissionDraftRequest,
    ) -> Result<MarketSubmission, MarketClientError> {
        let request = self
            .authorized(self.client.post(self.url("/submissions")))
            .await?;
        self.json(request.json(draft)).await
    }

    pub async fn upload_submission_package(
        &mut self,
        submission_id: &str,
        bytes: Vec<u8>,
    ) -> Result<MarketSubmission, MarketClientError> {
        let request = self
            .authorized(self.client.put(self.url(&format!(
                "/submissions/{}/package",
                urlencoding::encode(submission_id)
            ))))
            .await?;
        self.json(
            request
                .header(reqwest::header::CONTENT_TYPE, MARKET_PACKAGE_CONTENT_TYPE)
                .body(bytes),
        )
        .await
    }

    pub async fn upload_submission_screenshot(
        &mut self,
        submission_id: &str,
        position: u32,
        media_type: &str,
        bytes: Vec<u8>,
    ) -> Result<MarketSubmission, MarketClientError> {
        let request = self
            .authorized(self.client.put(self.url(&format!(
                "/submissions/{}/screenshots/{position}",
                urlencoding::encode(submission_id)
            ))))
            .await?;
        self.json(
            request
                .header(reqwest::header::CONTENT_TYPE, media_type)
                .body(bytes),
        )
        .await
    }

    pub async fn submit_submission(
        &mut self,
        submission_id: &str,
    ) -> Result<MarketSubmission, MarketClientError> {
        let request = self
            .authorized(self.client.post(self.url(&format!(
                "/submissions/{}/submit",
                urlencoding::encode(submission_id)
            ))))
            .await?;
        self.json(request).await
    }

    pub async fn review_submission(
        &mut self,
        submission_id: &str,
        decision: &ReviewDecisionRequest,
    ) -> Result<MarketSubmission, MarketClientError> {
        let request = self
            .authorized(self.client.post(self.url(&format!(
                "/admin/submissions/{}/decision",
                urlencoding::encode(submission_id)
            ))))
            .await?;
        self.json(request.json(decision)).await
    }

    pub async fn logout(&mut self) -> Result<(), MarketClientError> {
        self.identity.logout().await
    }

    async fn authorized(
        &mut self,
        request: RequestBuilder,
    ) -> Result<RequestBuilder, MarketClientError> {
        let token = self.identity.access_token().await?.ok_or_else(|| {
            local_error(
                "authentication_required",
                "Sign in with GitHub to continue.",
            )
        })?;
        Ok(request.bearer_auth(token))
    }

    async fn json<T: DeserializeOwned>(
        &self,
        request: RequestBuilder,
    ) -> Result<T, MarketClientError> {
        let response = request.send().await.map_err(transport_error)?;
        decode_json(checked_response(response).await?).await
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }
}

fn market_sort_value(sort: MarketSort) -> &'static str {
    match sort {
        MarketSort::Newest => "newest",
        MarketSort::Downloads => "downloads",
        MarketSort::Rating => "rating",
    }
}

async fn checked_response(response: Response) -> Result<Response, MarketClientError> {
    if response.status().is_success() {
        Ok(response)
    } else {
        Err(response_error(response).await)
    }
}

async fn decode_json<T: DeserializeOwned>(response: Response) -> Result<T, MarketClientError> {
    response
        .json()
        .await
        .map_err(|error| local_error("invalid_market_response", error.to_string()))
}

async fn response_error(response: Response) -> MarketClientError {
    let status = response.status();
    match response.json::<ErrorEnvelope>().await {
        Ok(envelope) => MarketClientError {
            code: envelope.error.code,
            message: envelope.error.message,
            request_id: envelope.error.request_id,
        },
        Err(_) => local_error(
            "market_request_failed",
            format!("The MiniApp market returned HTTP {status}."),
        ),
    }
}

fn transport_error(error: reqwest::Error) -> MarketClientError {
    local_error("market_unavailable", error.to_string())
}

fn local_error(code: impl Into<String>, message: impl Into<String>) -> MarketClientError {
    MarketClientError {
        code: code.into(),
        message: message.into(),
        request_id: None,
    }
}
