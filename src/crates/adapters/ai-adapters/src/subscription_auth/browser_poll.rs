//! JSON envelopes used by browser authorization polling APIs. Never put a
//! response body in an error: successful token payloads can accompany failures.
use anyhow::{anyhow, Context, Result};
use serde_json::Value;

#[derive(Debug)]
pub(super) struct ApiError {
    pub status: u16,
    pub code: i64,
}
impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Subscription API refused request (HTTP {}, code {})",
            self.status, self.code
        )
    }
}
impl std::error::Error for ApiError {}

pub(super) async fn data(request: reqwest::RequestBuilder, accept_200: bool) -> Result<Value> {
    let response = request
        .send()
        .await
        .context("send subscription API request")?;
    let status = response.status();
    let value: Value = response
        .json()
        .await
        .context("parse subscription API envelope")?;
    let code = value.get("code").map(integer).unwrap_or(0);
    if !status.is_success() || (code != 0 && !(accept_200 && code == 200)) {
        return Err(ApiError {
            status: status.as_u16(),
            code,
        }
        .into());
    }
    value
        .get("data")
        .cloned()
        .ok_or_else(|| anyhow!("Subscription API response missing data"))
}

pub(super) fn integer(value: &Value) -> i64 {
    value
        .as_i64()
        .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
        .unwrap_or(0)
}

pub(super) fn text<'a>(value: &'a Value, field: &str) -> &'a str {
    value
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
}

pub(super) fn required<'a>(value: &'a Value, field: &str) -> Result<&'a str> {
    let value = text(value, field);
    if value.is_empty() {
        Err(anyhow!("Subscription API response missing {field}"))
    } else {
        Ok(value)
    }
}

/// Browser pages may be hosted by an identity provider; require HTTPS and no
/// URL credentials. Inference/token endpoints are always adapter constants.
pub(super) fn authorization_url(raw: &str) -> Result<reqwest::Url> {
    let url = reqwest::Url::parse(raw).context("parse subscription authorization URL")?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(anyhow!("Unsupported subscription authorization URL"));
    }
    Ok(url)
}

pub(super) fn set_query(url: &mut reqwest::Url, name: &str, value: &str) {
    let query: Vec<_> = url
        .query_pairs()
        .filter(|(key, _)| key != name)
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    url.set_query(None);
    url.query_pairs_mut()
        .extend_pairs(query)
        .append_pair(name, value);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_unsafe_browser_urls() {
        for url in [
            "http://example.com/login",
            "https://user:secret@example.com/login",
            "/login",
            "file:///tmp/token",
        ] {
            assert!(authorization_url(url).is_err());
        }
        authorization_url("https://example.com/login?state=fixture").unwrap();
        let mut url =
            authorization_url("https://example.com/login?redirect=old&state=fixture").unwrap();
        set_query(&mut url, "redirect", "https://example.com/callback");
        assert_eq!(
            url.query_pairs()
                .filter(|(key, _)| key == "redirect")
                .count(),
            1
        );
        assert!(url
            .query_pairs()
            .any(|(key, value)| key == "state" && value == "fixture"));
    }

    #[tokio::test]
    #[ignore = "Creates short-lived authorization flows against the real vendor APIs; no account is authorized or stored"]
    async fn live_browser_authorization_endpoints() {
        use super::super::{workbuddy, zcode, SubscriptionHttpOptions, SubscriptionProvider};
        let proxy = std::env::var("OPENBITFUN_LIVE_SUBSCRIPTION_PROXY")
            .ok()
            .map(|url| crate::types::ProxyConfig {
                enabled: true,
                url,
                username: None,
                password: None,
            });
        let options = SubscriptionHttpOptions::new(proxy, false);
        for provider in [
            SubscriptionProvider::Workbuddy,
            SubscriptionProvider::WorkbuddyAi,
            SubscriptionProvider::Zcode,
            SubscriptionProvider::ZcodeCn,
        ] {
            let slot = format!("{}-account-{}", provider.key(), uuid::Uuid::new_v4());
            let result = match provider {
                SubscriptionProvider::Workbuddy | SubscriptionProvider::WorkbuddyAi => {
                    workbuddy::begin_login_for_account(
                        provider,
                        slot,
                        tokio_util::sync::CancellationToken::new(),
                        0,
                        options.clone(),
                    )
                    .await
                }
                _ => {
                    zcode::begin_login_for_account(
                        provider,
                        slot,
                        tokio_util::sync::CancellationToken::new(),
                        0,
                        options.clone(),
                    )
                    .await
                }
            };
            let started = result.unwrap_or_else(|error| panic!("{}: {error:#}", provider.key()));
            let url = authorization_url(&started.authorization_url).unwrap();
            println!(
                "{}: authorization endpoint accepted; browser host={}",
                provider.key(),
                url.host_str().unwrap()
            );
            // Never poll the returned future or persist any account in this probe.
            drop(started);
        }
    }
}
