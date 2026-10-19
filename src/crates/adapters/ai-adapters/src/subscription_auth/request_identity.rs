//! Recheck the explicitly resolved account immediately before sending HTTP.
//! This guard does not reserve capacity or create routing/capacity files.
use super::{accounts::validate_account_id, store, StoredCredential, SubscriptionProvider};
use crate::client::AIClient;
use anyhow::Result;
use openbitfun_core_types::errors::{AiProviderError, ErrorCategory};
use sha2::{Digest, Sha256};

fn admission_error(message: impl std::fmt::Display, credentials_changed: bool) -> anyhow::Error {
    let mut detail = AiProviderError::classified(
        format!("Local subscription account admission failed: {message}"),
        if credentials_changed {
            ErrorCategory::Auth
        } else {
            ErrorCategory::InvalidRequest
        },
    );
    detail.provider_code = Some(
        if credentials_changed {
            "subscription_account_credentials_changed"
        } else {
            "subscription_account_admission_unavailable"
        }
        .into(),
    );
    anyhow::Error::new(detail)
}

#[derive(Clone)]
pub(crate) struct AccountRequestIdentity {
    provider: SubscriptionProvider,
    account_id: String,
    access_digest: [u8; 32],
    upstream_account_id: Option<String>,
}

impl std::fmt::Debug for AccountRequestIdentity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AccountRequestIdentity")
            .field("account_id", &self.account_id)
            .finish_non_exhaustive()
    }
}

impl AccountRequestIdentity {
    pub(crate) fn bind(client: &AIClient, account_id: &str) -> Self {
        Self {
            provider: SubscriptionProvider::Codex,
            account_id: account_id.into(),
            access_digest: Sha256::digest(client.config.api_key.as_bytes()).into(),
            upstream_account_id: client
                .subscription_account_origin(account_id)
                .and_then(|origin| origin.upstream_account_id),
        }
    }

    pub(crate) fn bind_resolved(
        client: &AIClient,
        provider: SubscriptionProvider,
        account_id: &str,
        upstream_account_id: Option<String>,
    ) -> Self {
        Self {
            provider,
            account_id: account_id.into(),
            access_digest: Sha256::digest(client.config.api_key.as_bytes()).into(),
            upstream_account_id,
        }
    }

    pub(crate) fn origin(
        &self,
        account_id: &str,
    ) -> Option<openbitfun_core_types::ModelAccountOrigin> {
        (account_id == self.account_id).then(|| openbitfun_core_types::ModelAccountOrigin {
            provider: self.provider.key().into(),
            account_id: self.account_id.clone(),
            upstream_account_id: self.upstream_account_id.clone(),
        })
    }

    pub(crate) async fn validate(&self, client: &AIClient) -> Result<()> {
        validate_account_id(self.provider, &self.account_id)
            .map_err(|error| admission_error(error, false))?;
        let digest: [u8; 32] = Sha256::digest(client.config.api_key.as_bytes()).into();
        let seat = client
            .subscription_account_origin(&self.account_id)
            .and_then(|origin| origin.upstream_account_id);
        if client.subscription_provider_key() != Some(self.provider.key())
            || digest != self.access_digest
            || seat != self.upstream_account_id
        {
            return Err(admission_error(
                "Subscription client identity changed; resolve the account again",
                false,
            ));
        }
        let mut state = store::load_with_state()
            .await
            .map_err(|error| admission_error(error, false))?;
        if state.vault_unavailable.contains(&self.account_id) {
            return Err(admission_error(
                "Credential vault is locked or unavailable; restore storage access before retrying",
                false,
            ));
        }
        if state
            .account_metadata
            .get(&self.account_id)
            .is_some_and(|metadata| !metadata.enabled)
        {
            return Err(admission_error(
                "Subscription account is disabled; enable it before making model requests",
                true,
            ));
        }
        match state.credentials.remove(&self.account_id) {
            Some(StoredCredential::Oauth {
                access,
                account_id,
                expires,
                ..
            }) if <[u8; 32]>::from(Sha256::digest(access.as_bytes())) == self.access_digest
                && account_id == self.upstream_account_id
                && expires > chrono::Utc::now().timestamp_millis() =>
            {
                Ok(())
            }
            Some(StoredCredential::Api { key, .. })
                if self.provider == SubscriptionProvider::Opencode
                    && self.upstream_account_id.is_none()
                    && <[u8; 32]>::from(Sha256::digest(key.as_bytes())) == self.access_digest =>
            {
                Ok(())
            }
            _ => Err(admission_error(
                "Subscription credentials changed or are unavailable; resolve the account again",
                true,
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::{StreamOptions, StreamResponse};
    use crate::types::AIConfig;
    use axum::{body::Body, extract::State, response::IntoResponse, routing::post, Router};
    use futures::StreamExt;
    use std::{
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        },
        time::Duration,
    };
    use tokio::sync::Semaphore;
    #[derive(Clone)]
    struct FixtureState {
        requests: Arc<AtomicUsize>,
        finish: Arc<Semaphore>,
    }

    struct Fixture {
        url: String,
        state: FixtureState,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    impl Fixture {
        async fn start() -> Self {
            let state = FixtureState {
                requests: Arc::new(AtomicUsize::new(0)),
                finish: Arc::new(Semaphore::new(0)),
            };
            let app = Router::new().route("/responses", post(|State(state):State<FixtureState>| async move {
                state.requests.fetch_add(1, Ordering::SeqCst);
                let chunks = futures::stream::once(async { Ok::<_, std::io::Error>("data: {\"type\":\"response.output_text.delta\",\"delta\":\"ok\"}\n\n") })
                    .chain(futures::stream::once(async move {
                        state.finish.acquire_owned().await.unwrap().forget();
                        Ok::<_, std::io::Error>("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"identity-fixture\",\"output\":[],\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n")
                    }));
                ([("content-type", "text/event-stream")], Body::from_stream(chunks)).into_response()
            }))
            .route("/concurrency", post(|| async { (axum::http::StatusCode::TOO_MANY_REQUESTS, [("retry-after", "0")], r#"{"error":{"message":"Concurrent request limit reached"}}"#) }))
            .with_state(state.clone());
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}/responses", listener.local_addr().unwrap());
            let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            Self { url, state, task }
        }
    }

    async fn credential(access: &str) {
        store::upsert(
            "codex",
            StoredCredential::Oauth {
                refresh: "synthetic-refresh".into(),
                access: access.into(),
                expires: chrono::Utc::now().timestamp_millis() + 3_600_000,
                account_id: Some("synthetic-seat".into()),
                metadata: None,
            },
        )
        .await
        .unwrap();
    }

    fn client(url: &str, access: &str, ttft: Option<Duration>) -> AIClient {
        AIClient::new_with_runtime_options(
            AIConfig {
                name: "identity fixture".into(),
                base_url: url.into(),
                request_url: url.into(),
                api_key: access.into(),
                model: "synthetic-model".into(),
                format: "responses".into(),
                context_window: 128_000,
                max_tokens: None,
                temperature: None,
                top_p: None,
                inline_think_in_text: false,
                custom_headers: Some(std::collections::HashMap::from([(
                    "ChatGPT-Account-ID".into(),
                    "synthetic-seat".into(),
                )])),
                custom_headers_mode: None,
                skip_ssl_verify: false,
                custom_request_body: None,
                custom_request_body_mode: None,
            },
            None,
            StreamOptions {
                idle_timeout: None,
                ttft_timeout: ttft,
            },
        )
        .with_subscription_account(SubscriptionProvider::Codex, "codex")
    }

    async fn send(client: &AIClient) -> Result<StreamResponse> {
        client
            .send_message_stream_once(Vec::new(), None, None)
            .await
    }

    #[tokio::test]
    async fn requests_ignore_capacity_files_and_do_not_register_occupancy() {
        let _guard = super::super::tests::test_lock().lock().await;
        let metadata = super::super::tests::temp_store_path();
        store::set_store_path_for_test(metadata.clone());
        credential("synthetic-access").await;
        let fixture = Fixture::start().await;
        let account = client(&fixture.url, "synthetic-access", None);
        let response = send(&account).await.unwrap();
        assert!(!metadata.with_extension("capacity").exists());
        drop(response);
        // Even an unreadable prior capacity tree must not gate normal requests.
        tokio::fs::write(
            metadata.with_extension("capacity"),
            b"unsupported capacity state",
        )
        .await
        .unwrap();
        let response = send(&account).await.unwrap();
        drop(response);
        assert_eq!(fixture.state.requests.load(Ordering::SeqCst), 2);
        assert_eq!(
            tokio::fs::read(metadata.with_extension("capacity"))
                .await
                .unwrap(),
            b"unsupported capacity state"
        );
    }

    #[tokio::test]
    async fn credential_changed_while_in_the_adaptive_queue_is_not_sent() {
        let _guard = super::super::tests::test_lock().lock().await;
        store::set_store_path_for_test(super::super::tests::temp_store_path());
        credential("synthetic-old").await;
        let fixture = Fixture::start().await;
        let seed = client(
            &fixture.url.replace("/responses", "/concurrency"),
            "synthetic-old",
            None,
        );
        assert!(send(&seed).await.is_err());
        let account = client(&fixture.url, "synthetic-old", None);
        let first = tokio::time::timeout(Duration::from_secs(3), send(&account))
            .await
            .unwrap()
            .unwrap();
        let queued = send(&account);
        tokio::pin!(queued);
        assert!(tokio::time::timeout(Duration::from_millis(60), &mut queued)
            .await
            .is_err());
        credential("synthetic-replacement").await;
        fixture.state.finish.add_permits(1);
        let error = tokio::time::timeout(Duration::from_secs(3), queued)
            .await
            .unwrap()
            .err()
            .unwrap();
        assert_eq!(
            error.downcast_ref::<AiProviderError>().unwrap().category,
            ErrorCategory::Auth
        );
        assert_eq!(
            fixture.state.requests.load(Ordering::SeqCst),
            1,
            "the queued stale credential must never reach HTTP"
        );
        drop(first);
    }

    #[tokio::test]
    async fn rotated_or_disabled_credentials_are_rejected_before_http() {
        let _guard = super::super::tests::test_lock().lock().await;
        store::set_store_path_for_test(super::super::tests::temp_store_path());
        credential("synthetic-old").await;
        let fixture = Fixture::start().await;
        let stale = client(&fixture.url, "synthetic-old", None);
        credential("synthetic-new").await;
        let error = send(&stale).await.err().unwrap();
        let detail = error.downcast_ref::<AiProviderError>().unwrap();
        assert_eq!(detail.category, ErrorCategory::Auth);
        assert_eq!(detail.http_status, None);
        let current = client(&fixture.url, "synthetic-new", None);
        super::super::set_account_instance_enabled(SubscriptionProvider::Codex, "codex", false)
            .await
            .unwrap();
        let error = send(&current).await.err().unwrap();
        assert_eq!(
            error.downcast_ref::<AiProviderError>().unwrap().category,
            ErrorCategory::Auth
        );
        assert_eq!(fixture.state.requests.load(Ordering::SeqCst), 0);
    }
}
