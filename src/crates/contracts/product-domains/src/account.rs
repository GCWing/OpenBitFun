//! Account identity projections shared by product surfaces.

use serde::{Deserialize, Serialize};

/// Hosted Relay service version announced by the official endpoint.
///
/// This is the *service* release the client targets, not the product build
/// version. Keep it in sync with `relay-service/Cargo.toml`.
pub const RELAY_SERVICE_VERSION: &str = "1.0.10";

/// Endpoint paths served by the same deployed Relay and the same account
/// database. `?v=` replaced the path segment as the client-facing version, but
/// `/v/1.0.2` must keep working for builds that predate the change: a token,
/// master key, or device registration from either path is interchangeable
/// because both reach one process and one SQLite file.
pub const LIVE_RELAY_ENDPOINT_PATHS: &[&str] = &["/relay", "/v/1.0.2"];

/// Hosted Relay deployment for the GitHub account/device-key protocol.
///
/// The version travels as a GET parameter so a release no longer needs a new
/// proxy location, while `remote.openbitfun.com` keeps one root page. Callers
/// must join API paths onto [`relay_endpoint_base`], never onto this string.
pub const DEFAULT_RELAY_URL: &str = "https://remote.openbitfun.com/relay?v=1.0.10";

/// Strip the version query and any fragment so the endpoint can be joined with
/// an API path. A trailing slash is removed so `{base}/api/...` stays correct.
pub fn relay_endpoint_base(endpoint: &str) -> &str {
    let endpoint = endpoint.trim();
    let end = endpoint
        .find(['?', '#'])
        .unwrap_or(endpoint.len());
    endpoint[..end].trim_end_matches('/')
}

/// Service version announced by the endpoint's `?v=` parameter, if any.
///
/// Only the first `v` parameter of the query is considered. Callers still
/// validate the value; this helper only extracts it.
pub fn relay_endpoint_version(endpoint: &str) -> Option<&str> {
    let query = endpoint.split_once('?')?.1;
    let query = query.split('#').next().unwrap_or(query);
    query
        .split('&')
        .find_map(|pair| pair.strip_prefix("v="))
        .filter(|value| !value.is_empty())
}

fn endpoint_authority(endpoint: &str) -> Option<(&str, &str)> {
    let (scheme, rest) = endpoint.split_once("://")?;
    if !matches!(scheme, "http" | "https") {
        return None;
    }
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    if authority.is_empty() || authority.contains('@') {
        return None;
    }
    Some((scheme, authority))
}

/// Path portion of an endpoint, without query, fragment, or trailing slash.
fn endpoint_path(endpoint: &str) -> &str {
    let Some((_, rest)) = endpoint.trim().split_once("://") else {
        return "";
    };
    let rest = match rest.find(['?', '#']) {
        Some(end) => &rest[..end],
        None => rest,
    };
    match rest.find('/') {
        Some(index) => rest[index..].trim_end_matches('/'),
        None => "",
    }
}

/// Whether two endpoints resolve to the same deployed Relay.
///
/// Both live aliases of the same host count as one deployment, so a build that
/// switches from `/v/1.0.2` to `/relay?v=` keeps its stored credential and
/// master key. A different host, or a different `/v/<version>` path, does not.
pub fn same_relay_deployment(left: &str, right: &str) -> bool {
    let (Some((left_scheme, left_authority)), Some((right_scheme, right_authority))) =
        (endpoint_authority(left), endpoint_authority(right))
    else {
        return false;
    };
    if left_scheme != right_scheme || !left_authority.eq_ignore_ascii_case(right_authority) {
        return false;
    }
    let (left_path, right_path) = (endpoint_path(left), endpoint_path(right));
    left_path == right_path
        || (LIVE_RELAY_ENDPOINT_PATHS.contains(&left_path)
            && LIVE_RELAY_ENDPOINT_PATHS.contains(&right_path))
}

/// User-facing page URL for an endpoint, keeping `?v=` before the fragment so
/// the version survives in the address bar and in shared links.
pub fn relay_page_url(endpoint: &str, fragment: &str) -> String {
    let base = relay_endpoint_base(endpoint);
    match relay_endpoint_version(endpoint) {
        Some(version) => format!("{base}/?v={version}{fragment}"),
        None => format!("{base}/{fragment}"),
    }
}

/// Control-contract protocol number reported to the Relay alongside the build
/// string when a device registers or opens its realtime connection.
///
/// Two devices are mutually controllable only when BOTH report a number AND the
/// numbers are equal: `(Some(a), Some(b)) && a == b`. A device that has never
/// reported a protocol number is therefore incompatible, never
/// "legacy-compatible", and so is any pair whose numbers differ.
///
/// Compatibility is decided solely by the Relay from the two stored numbers:
/// clients read the Relay-computed `compatible` flag on the device directory
/// instead of re-deriving this rule locally.
///
/// Semantics:
///
/// - unreported: a build that never sent a protocol number (incompatible);
/// - this build: `2`;
/// - increment only on a breaking change to the client control contract.
pub const CLIENT_PROTOCOL_VERSION: u32 = 2;

/// The product build string reported to the Relay for diagnostics next to
/// [`CLIENT_PROTOCOL_VERSION`].
///
/// Every workspace member inherits `version.workspace = true`, so this
/// compile-time value is the single product version actually shipped to users.
/// Keeping it beside the protocol number lets the shared account/relay owners
/// report it without threading a host parameter through every call site, and
/// without a lower crate importing an upper crate's version.
pub fn client_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

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
    /// Kind the device reported to the Relay (`desktop`, `cli`, `mobile`,
    /// `watch`). Absent for a device that never reported one and for Relays that
    /// predate the field: absent stays "unknown", which is not "not a host".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_alias: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_os: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_os_version: Option<String>,
    /// Build string the device last reported to the Relay. Absent for legacy
    /// devices and for Relays that predate the field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_client_version: Option<String>,
    /// Control-contract protocol number the device last reported. Absent for
    /// legacy devices and for Relays that predate the field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_client_protocol: Option<u32>,
    /// Relay-computed compatibility with this client's control contract.
    /// `None` means unknown (an older Relay without the field) and must be
    /// treated as compatible rather than incompatible.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compatible: Option<bool>,
    pub online: bool,
}

impl AccountDevice {
    /// Whether the Relay considers this device compatible with our control
    /// contract.
    ///
    /// A `Some(false)` answer means the pair must not be remote-controlled:
    /// this is what the Relay computes for a device that never reported a
    /// [`CLIENT_PROTOCOL_VERSION`], or one whose number differs from ours. A
    /// missing flag (`None`) means an older Relay that predates the gating field
    /// and cannot judge at all, so it is unknown and treated as compatible.
    ///
    /// Keep these two cases distinct: "device lacks a version" is judged
    /// incompatible by the Relay (`Some(false)`); "old Relay cannot judge" is
    /// `None`. Do not widen the fallback to cover a device that simply has no
    /// version.
    pub fn is_compatible(&self) -> bool {
        self.compatible.unwrap_or(true)
    }

    pub fn display_name(&self) -> &str {
        self.device_alias.as_deref().unwrap_or_else(|| {
            if self.device_name.is_empty() {
                &self.device_id
            } else {
                &self.device_name
            }
        })
    }
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
    fn device_directory_legacy_round_trip_preserves_technical_name() {
        let legacy = serde_json::json!({"deviceId":"id", "deviceName":"technical", "online":true});
        let mut device: AccountDevice = serde_json::from_value(legacy.clone()).unwrap();
        assert_eq!(serde_json::to_value(&device).unwrap(), legacy);
        device.device_alias = Some("My laptop".into());
        device.device_model = Some("Mac14,7".into());
        device.device_os = Some("macos".into());
        device.device_os_version = Some("15.0".into());
        let round_trip: AccountDevice =
            serde_json::from_value(serde_json::to_value(&device).unwrap()).unwrap();
        assert_eq!(device, round_trip);
        assert_eq!(round_trip.display_name(), "My laptop");
        assert_eq!(round_trip.device_name, "technical");
        device.device_alias = None;
        assert_eq!(device.display_name(), "technical");
        device.device_name.clear();
        assert_eq!(device.display_name(), "id");
    }

    #[test]
    fn device_directory_client_compatibility_preserves_legacy_shape() {
        // A legacy payload without the new fields round-trips unchanged and is
        // treated as compatible, so an older Relay is never misjudged.
        let legacy = serde_json::json!({"deviceId":"id", "deviceName":"technical", "online":true});
        let device: AccountDevice = serde_json::from_value(legacy.clone()).unwrap();
        assert!(device.compatible.is_none());
        assert!(device.is_compatible());
        assert!(device.device_client_version.is_none());
        assert!(device.device_client_protocol.is_none());
        assert_eq!(serde_json::to_value(&device).unwrap(), legacy);

        // A device that never reported a version is judged incompatible by the
        // Relay: `compatible` is present and false.
        let unversioned: AccountDevice = serde_json::from_value(serde_json::json!({
            "deviceId":"id", "deviceName":"technical", "online":true, "compatible":false
        }))
        .unwrap();
        assert!(unversioned.device_client_protocol.is_none());
        assert!(!unversioned.is_compatible());

        // A Relay that reports a mismatched build carries the values through.
        let reported: AccountDevice = serde_json::from_value(serde_json::json!({
            "deviceId":"id", "deviceName":"technical", "online":true,
            "deviceClientVersion":"0.9.0", "deviceClientProtocol":1, "compatible":false
        }))
        .unwrap();
        assert_eq!(reported.device_client_version.as_deref(), Some("0.9.0"));
        assert_eq!(reported.device_client_protocol, Some(1));
        assert!(!reported.is_compatible());
        let round_trip: AccountDevice =
            serde_json::from_value(serde_json::to_value(&reported).unwrap()).unwrap();
        assert_eq!(reported, round_trip);
    }

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

#[cfg(test)]
mod relay_endpoint_tests {
    use super::*;

    #[test]
    fn base_strips_version_query_and_fragment() {
        assert_eq!(
            relay_endpoint_base("https://remote.openbitfun.com/relay?v=1.0.9"),
            "https://remote.openbitfun.com/relay"
        );
        assert_eq!(
            relay_endpoint_base("https://remote.openbitfun.com/relay/?v=1.0.9"),
            "https://remote.openbitfun.com/relay"
        );
        assert_eq!(
            relay_endpoint_base("https://remote.openbitfun.com/v/1.0.2/"),
            "https://remote.openbitfun.com/v/1.0.2"
        );
        assert_eq!(
            relay_endpoint_base("https://relay.example.com/prefix#/pair"),
            "https://relay.example.com/prefix"
        );
    }

    #[test]
    fn version_is_read_from_the_query_only() {
        assert_eq!(
            relay_endpoint_version("https://remote.openbitfun.com/relay?v=1.0.9"),
            Some("1.0.9")
        );
        assert_eq!(
            relay_endpoint_version("https://remote.openbitfun.com/relay?v=1.0.9#/pair?did=x"),
            Some("1.0.9")
        );
        assert_eq!(
            relay_endpoint_version("https://remote.openbitfun.com/v/1.0.2"),
            None
        );
    }

    #[test]
    fn live_aliases_share_one_deployment_but_other_releases_do_not() {
        assert!(same_relay_deployment(
            "https://remote.openbitfun.com/relay?v=1.0.9",
            "https://remote.openbitfun.com/v/1.0.2",
        ));
        assert!(same_relay_deployment(
            "https://remote.openbitfun.com/relay",
            "https://remote.openbitfun.com/relay/",
        ));
        assert!(!same_relay_deployment(
            "https://remote.openbitfun.com/v/1.0.1",
            "https://remote.openbitfun.com/relay",
        ));
        assert!(!same_relay_deployment(
            "https://other.example.com/relay",
            "https://remote.openbitfun.com/relay",
        ));
        assert!(!same_relay_deployment(
            "http://remote.openbitfun.com/relay",
            "https://remote.openbitfun.com/relay",
        ));
    }

    #[test]
    fn page_url_keeps_version_before_the_fragment() {
        assert_eq!(
            relay_page_url("https://remote.openbitfun.com/relay?v=1.0.9", "#/pair?did=abc"),
            "https://remote.openbitfun.com/relay/?v=1.0.9#/pair?did=abc"
        );
        assert_eq!(
            relay_page_url("https://remote.openbitfun.com/v/1.0.2", "#/pair?did=abc"),
            "https://remote.openbitfun.com/v/1.0.2/#/pair?did=abc"
        );
    }
}
