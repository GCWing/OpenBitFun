//! Verification against the shared OpenBitFun GitHub identity authority.
//! Relay receives an OpenBitFun access token, never a GitHub OAuth secret.

use axum::http::StatusCode;
use serde::Deserialize;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub(crate) const IDENTITY_ME_URL: &str = "https://auth.openbitfun.com/api/v1/me";

#[derive(Clone)]
pub(crate) struct IdentityVerifier {
    client: reqwest::Client,
    me_url: reqwest::Url,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VerifiedIdentity {
    #[serde(default)]
    pub account_id: Option<String>,
    pub github_id: i64,
    pub login: String,
}

#[derive(Deserialize)]
struct IdentityResponse {
    user: VerifiedIdentity,
}

/// A completed poll response kept long enough to make the authority's
/// single-use transaction safe to retry after a lost HTTP response.
struct CompletedPoll {
    payload: serde_json::Value,
    expires_at: i64,
}

/// Terminal sign-in outcomes are keyed by both transaction id and secret.
/// A different secret must never overwrite the valid client's replay entry.
fn completed_authorizations() -> &'static Mutex<HashMap<(String, String), CompletedPoll>> {
    static COMPLETED: OnceLock<Mutex<HashMap<(String, String), CompletedPoll>>> = OnceLock::new();
    COMPLETED.get_or_init(|| Mutex::new(HashMap::new()))
}

const POLL_REPLAY_SECS: i64 = 900;

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn replay_completed_poll(
    transaction_id: &str,
    transaction_secret: &str,
) -> Option<serde_json::Value> {
    let key = (transaction_id.to_string(), transaction_secret.to_string());
    let mut completed = completed_authorizations()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    completed.retain(|_, poll| poll.expires_at > now_secs());
    completed.get(&key).map(|poll| poll.payload.clone())
}

fn remember_completed_poll(
    transaction_id: &str,
    transaction_secret: &str,
    payload: &serde_json::Value,
) {
    if payload.get("status").and_then(|status| status.as_str()) == Some("pending") {
        return;
    }
    let key = (transaction_id.to_string(), transaction_secret.to_string());
    let mut completed = completed_authorizations()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    completed.retain(|_, poll| poll.expires_at > now_secs());
    completed.insert(
        key,
        CompletedPoll {
            payload: payload.clone(),
            expires_at: now_secs() + POLL_REPLAY_SECS,
        },
    );
}

impl IdentityVerifier {
    pub(crate) async fn start_auth(
        &self,
        all_methods: bool,
    ) -> Result<serde_json::Value, StatusCode> {
        self.auth_request(
            if all_methods {
                "auth/desktop/start?methods=all"
            } else {
                "auth/desktop/start"
            },
            serde_json::json!({}),
        )
        .await
    }

    pub(crate) async fn poll_auth(
        &self,
        transaction_id: &str,
        transaction_secret: &str,
    ) -> Result<serde_json::Value, StatusCode> {
        if transaction_id.is_empty()
            || transaction_id.len() > 256
            || transaction_secret.is_empty()
            || transaction_secret.len() > 1024
        {
            return Err(StatusCode::BAD_REQUEST);
        }
        if let Some(payload) = replay_completed_poll(transaction_id, transaction_secret) {
            return Ok(payload);
        }
        let payload = self
            .auth_request(
                "auth/desktop/poll",
                serde_json::json!({
                    "transactionId": transaction_id,
                    "transactionSecret": transaction_secret,
                }),
            )
            .await?;
        remember_completed_poll(transaction_id, transaction_secret, &payload);
        Ok(payload)
    }

    async fn auth_request(
        &self,
        path: &str,
        body: serde_json::Value,
    ) -> Result<serde_json::Value, StatusCode> {
        let url = self
            .me_url
            .join(path)
            .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
        let _permit = identity_request_permit()?;
        let mut response = self
            .client
            .post(url)
            .json(&body)
            .send()
            .await
            .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
        if !response.status().is_success() {
            return Err(match response.status() {
                StatusCode::BAD_REQUEST
                | StatusCode::UNAUTHORIZED
                | StatusCode::GONE
                | StatusCode::TOO_MANY_REQUESTS => response.status(),
                _ => StatusCode::SERVICE_UNAVAILABLE,
            });
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?
        {
            if bytes.len() + chunk.len() > 65536 {
                return Err(StatusCode::SERVICE_UNAVAILABLE);
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| StatusCode::SERVICE_UNAVAILABLE)
    }

    pub(crate) fn new() -> anyhow::Result<Self> {
        Self::with_url(IDENTITY_ME_URL)
    }

    pub(crate) fn with_url(url: &str) -> anyhow::Result<Self> {
        let me_url = reqwest::Url::parse(url)?;
        anyhow::ensure!(
            me_url.scheme() == "https"
                || (cfg!(test)
                    && me_url.scheme() == "http"
                    && me_url.host_str() == Some("127.0.0.1")),
            "The identity authority must use HTTPS"
        );
        // Standalone relay does not link the workspace service facade. Select
        // ring for this client without installing a second process provider.
        let roots =
            rustls::RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let tls = rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()?
        .with_root_certificates(roots)
        .with_no_client_auth();
        Ok(Self {
            client: reqwest::Client::builder()
                .tls_backend_preconfigured(tls)
                .connect_timeout(Duration::from_secs(3))
                .timeout(Duration::from_secs(5))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            me_url,
        })
    }

    pub(crate) async fn verify(&self, token: &str) -> Result<VerifiedIdentity, StatusCode> {
        if token.is_empty()
            || token.len() > 8192
            || token
                .bytes()
                .any(|c| c.is_ascii_whitespace() || c.is_ascii_control())
        {
            return Err(StatusCode::UNAUTHORIZED);
        }
        let _permit = identity_request_permit()?;
        let mut response = self
            .client
            .get(self.me_url.clone())
            .bearer_auth(token)
            .send()
            .await
            .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
        if matches!(
            response.status(),
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
        ) {
            return Err(StatusCode::UNAUTHORIZED);
        }
        if !response.status().is_success() {
            return Err(StatusCode::SERVICE_UNAVAILABLE);
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?
        {
            if bytes.len() + chunk.len() > 65536 {
                return Err(StatusCode::SERVICE_UNAVAILABLE);
            }
            bytes.extend_from_slice(&chunk);
        }
        let identity: IdentityResponse =
            serde_json::from_slice(&bytes).map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
        let user = identity.user;
        if user.identity_id().is_none()
            || user.login.is_empty()
            || user.login.len() > 100
            || !user
                .login
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-')
        {
            return Err(StatusCode::SERVICE_UNAVAILABLE);
        }
        Ok(user)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{routing::get, Router};

    async fn verifier(
        status: StatusCode,
        body: &'static str,
    ) -> (IdentityVerifier, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/me", listener.local_addr().unwrap());
        let app = Router::new().route(
            "/me",
            get(move |headers: axum::http::HeaderMap| async move {
                assert_eq!(
                    headers.get("authorization").unwrap(),
                    "Bearer account-token"
                );
                (status, body)
            }),
        );
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (IdentityVerifier::with_url(&url).unwrap(), task)
    }

    #[tokio::test]
    async fn accepts_only_authority_verified_numeric_identity() {
        let (client, task) = verifier(
            StatusCode::OK,
            r#"{"user":{"githubId":123,"login":"alice"}}"#,
        )
        .await;
        let identity = client.verify("account-token").await.unwrap();
        assert_eq!(identity.github_id, 123);
        assert_eq!(identity.login, "alice");
        task.abort();
    }

    #[tokio::test]
    async fn email_identity_cannot_collide_with_a_legacy_github_account() {
        let (client, task) = verifier(
            StatusCode::OK,
            r#"{"user":{"accountId":"email-123","githubId":0,"login":"member"}}"#,
        )
        .await;
        let user = client.verify("account-token").await.unwrap();
        assert_eq!(user.identity_id().as_deref(), Some("email-123"));
        task.abort();
        let (client, task) = verifier(
            StatusCode::OK,
            r#"{"user":{"accountId":"123","githubId":0,"login":"member"}}"#,
        )
        .await;
        assert!(client.verify("account-token").await.is_err());
        task.abort();
    }

    #[tokio::test]
    async fn fails_closed_on_expired_tokens_unavailable_authority_and_invalid_profiles() {
        for (status, body, expected) in [
            (StatusCode::UNAUTHORIZED, "", StatusCode::UNAUTHORIZED),
            (StatusCode::FOUND, "", StatusCode::SERVICE_UNAVAILABLE),
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "",
                StatusCode::SERVICE_UNAVAILABLE,
            ),
            (
                StatusCode::OK,
                r#"{"user":{"githubId":0,"login":"alice"}}"#,
                StatusCode::SERVICE_UNAVAILABLE,
            ),
            (
                StatusCode::OK,
                r#"{"user":{"githubId":123,"login":"../bob"}}"#,
                StatusCode::SERVICE_UNAVAILABLE,
            ),
            (StatusCode::OK, "invalid", StatusCode::SERVICE_UNAVAILABLE),
        ] {
            let (client, task) = verifier(status, body).await;
            assert_eq!(client.verify("account-token").await.unwrap_err(), expected);
            task.abort();
        }
    }

    #[tokio::test]
    async fn poll_replays_a_completed_transaction_after_a_mismatched_secret() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let upstream_calls = Arc::new(AtomicUsize::new(0));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let transaction_id = format!("replayed-{}", listener.local_addr().unwrap().port());
        let url = format!("http://{}/me", listener.local_addr().unwrap());
        let counter = upstream_calls.clone();
        let app = Router::new().route(
            "/auth/desktop/poll",
            axum::routing::post(move || {
                let counter = counter.clone();
                async move {
                    if counter.fetch_add(1, Ordering::SeqCst) == 0 {
                        axum::Json(serde_json::json!({
                            "status": "authorized",
                            "tokens": { "accessToken": "token-1" },
                        }))
                    } else {
                        axum::Json(serde_json::json!({ "status": "consumed" }))
                    }
                }
            }),
        );
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let client = IdentityVerifier::with_url(&url).unwrap();

        let first = client.poll_auth(&transaction_id, "secret-1").await.unwrap();
        let repeated = client.poll_auth(&transaction_id, "secret-1").await.unwrap();
        let other_secret = client.poll_auth(&transaction_id, "secret-2").await.unwrap();
        let repeated_after_other_secret =
            client.poll_auth(&transaction_id, "secret-1").await.unwrap();

        assert_eq!(first["status"], "authorized");
        assert_eq!(repeated, first);
        assert_eq!(other_secret["status"], "consumed");
        assert_eq!(repeated_after_other_secret, first);
        assert_eq!(upstream_calls.load(Ordering::SeqCst), 2);
        task.abort();
    }
}

fn identity_request_permit() -> Result<tokio::sync::OwnedSemaphorePermit, StatusCode> {
    static REQUESTS: std::sync::OnceLock<Arc<tokio::sync::Semaphore>> = std::sync::OnceLock::new();
    Arc::clone(REQUESTS.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(64))))
        .try_acquire_owned()
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)
}

impl VerifiedIdentity {
    pub(crate) fn identity_id(&self) -> Option<String> {
        if self.github_id > 0 {
            return Some(self.github_id.to_string());
        }
        self.account_id
            .as_ref()
            .filter(|id| {
                id.starts_with("email-")
                    && id.len() <= 64
                    && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
            })
            .cloned()
    }
}
