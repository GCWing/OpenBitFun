//! Account identity projections shared by product surfaces.

use serde::{Deserialize, Serialize};

/// Versioned hosted Relay deployment for the GitHub account/device-key protocol.
pub const DEFAULT_RELAY_URL: &str = "https://remote.openbitfun.com/v/1.0.2";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountInfo {
    pub user_id: String,
    pub relay_url: String,
    pub device_id: String,
    pub device_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountDevice {
    pub device_id: String,
    pub device_name: String,
    pub online: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSnapshotProjection {
    pub logged_in: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub info: Option<AccountInfo>,
    #[serde(default)]
    pub devices: Vec<AccountDevice>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountLoginProjection {
    pub user_id: String,
    pub relay_url: String,
    pub status_message: String,
}

/// Verified GitHub profile for the global GitHub account.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubUser {
    /// Provider-independent identity; absent in legacy GitHub payloads.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    pub github_id: i64,
    pub login: String,
    pub avatar_url: String,
}

/// Public authorization progress. The transaction secret stays in its host.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubAuthStart {
    pub transaction_id: String,
    pub authorization_url: String,
    pub expires_at: i64,
    pub poll_interval_seconds: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubAuthPollRequest {
    pub transaction_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubAuthPollResponse {
    pub status: String,
}

impl GitHubUser {
    pub fn identity_id(&self) -> Option<String> {
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

#[cfg(test)]
mod identity_tests {
    use super::*;
    #[test]
    fn legacy_profile_round_trip_and_independent_email_identity() {
        let legacy = r#"{"githubId":42,"login":"alice","avatarUrl":""}"#;
        let user: GitHubUser = serde_json::from_str(legacy).unwrap();
        assert_eq!(user.identity_id().as_deref(), Some("42"));
        assert_eq!(
            serde_json::to_value(&user).unwrap(),
            serde_json::from_str::<serde_json::Value>(legacy).unwrap()
        );
        let email: GitHubUser = serde_json::from_str(
            r#"{"accountId":"email-7","githubId":0,"login":"user-7","avatarUrl":""}"#,
        )
        .unwrap();
        assert_eq!(email.identity_id().as_deref(), Some("email-7"));
        let invalid: GitHubUser = serde_json::from_str(
            r#"{"accountId":"42","githubId":0,"login":"user","avatarUrl":""}"#,
        )
        .unwrap();
        assert!(invalid.identity_id().is_none());
    }
}
