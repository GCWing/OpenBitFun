//! One vocabulary for "the account Relay could not be used".
//!
//! Mirrors `src/shared/relay-transport/RelayFailure.ts` so the desktop, mobile
//! web and CLI surfaces explain the same failure the same way and offer the
//! same next step; the raw transport detail stays in the log. Keep the kinds,
//! the markers and the status mapping in step with the TypeScript side.
//!
//! The classification is deliberately conservative: an unrecognized failure is
//! reported as retryable rather than blamed on the user's network or on the
//! client build.

use crate::remote_connect::account::is_retired_official_relay;
use crate::remote_connect::relay_http::is_transient_status;

/// Machine-readable reason of a retired Relay version. Mirrors the relay's own
/// answer (`retired_version` module in `openbitfun-relay-service`) and the
/// `deploy/relay-v1/nginx-retired-version.conf` snippet.
pub const RELAY_VERSION_RETIRED_CODE: &str = "relay_version_retired";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelayFailureKind {
    /// No usable transport at all: offline, DNS, refused connection, TLS.
    Network,
    /// Reachable but temporarily unable to serve: 408/425/429/5xx.
    RelayUnavailable,
    /// This Relay version has been retired; only a client update can help.
    RelayVersionRetired,
    /// The Relay refused this build: mutual control or an old interface.
    ClientOutdated,
    /// The account session must be established again.
    Auth,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelayFailureAction {
    Retry,
    CheckUpdates,
    SignIn,
}

impl RelayFailureKind {
    pub fn action(self) -> RelayFailureAction {
        match self {
            Self::RelayVersionRetired | Self::ClientOutdated => RelayFailureAction::CheckUpdates,
            Self::Auth => RelayFailureAction::SignIn,
            _ => RelayFailureAction::Retry,
        }
    }

    /// Whether retrying on its own, without user action, is worth it.
    pub fn is_retryable(self) -> bool {
        self.action() == RelayFailureAction::Retry
    }
}

/// Substrings of Relay refusals that mean "this build is too old to be served".
const OUTDATED_MARKERS: &[&str] = &[
    RELAY_VERSION_RETIRED_CODE,
    "relay_session_history_retired",
    "incompatible client build",
    "requires matching client versions",
    "update the controlling app",
    "update openbitfun on every device",
];

/// Substrings that mean the account session must be re-established.
const AUTH_MARKERS: &[&str] = &[
    "sign in",
    "unauthorized",
    "invalid or expired token",
    "expired token",
    "relay auth error",
    "http 401",
    "http 403",
];

/// Transport failures with no HTTP status, as reported by reqwest and the
/// socket stacks.
const NETWORK_MARKERS: &[&str] = &[
    "failed to fetch",
    "network error",
    "network unavailable",
    "load failed",
    "fetch failed",
    "econnrefused",
    "econnreset",
    "enotfound",
    "eai_again",
    "getaddrinfo",
    "connection refused",
    "connection closed",
    "connection reset",
    "socket hang up",
    "websocket connection failed",
    "timed out",
    "timeout",
    "certificate",
    "tls",
    "dns",
];

/// Classify a relay/account failure from its user-visible message.
pub fn classify_relay_failure(message: &str) -> RelayFailureKind {
    let lower = message.to_ascii_lowercase();
    if OUTDATED_MARKERS.iter().any(|marker| lower.contains(marker)) {
        return RelayFailureKind::ClientOutdated;
    }
    let status = http_status(&lower);
    if matches!(status, Some(401 | 403)) {
        return RelayFailureKind::Auth;
    }
    if AUTH_MARKERS.iter().any(|marker| lower.contains(marker)) {
        return RelayFailureKind::Auth;
    }
    // A retired version answers 410 before authentication, so a 410 on an
    // account route is always "this Relay version is gone".
    if status == Some(410) {
        return RelayFailureKind::RelayVersionRetired;
    }
    if let Some(status) = status {
        if status == 429 || reqwest::StatusCode::from_u16(status).is_ok_and(is_transient_status) {
            return RelayFailureKind::RelayUnavailable;
        }
    }
    if NETWORK_MARKERS.iter().any(|marker| lower.contains(marker)) {
        return RelayFailureKind::Network;
    }
    RelayFailureKind::Unknown
}

/// Classify the configured relay endpoint itself, before any request is made.
///
/// An official deployment other than the one this build targets is retired by
/// definition, so its token can never be replayed.
pub fn classify_relay_endpoint(relay_url: &str) -> Option<RelayFailureKind> {
    is_retired_official_relay(relay_url).then_some(RelayFailureKind::RelayVersionRetired)
}

/// HTTP status embedded in a message, as `error_from_response_parts` and the
/// transport layer render it (`"(HTTP 502)"`, `"relay returned HTTP 502"`).
fn http_status(lower: &str) -> Option<u16> {
    let mut search = lower;
    while let Some(index) = search.find("http ") {
        let rest = &search[index + 5..];
        let digits: String = rest
            .chars()
            .take_while(char::is_ascii_digit)
            .take(3)
            .collect();
        if digits.len() == 3 {
            if let Ok(status) = digits.parse() {
                return Some(status);
            }
        }
        search = rest;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use openbitfun_product_domains::account::DEFAULT_RELAY_URL;

    #[test]
    fn a_retired_version_is_an_update_not_a_network_fault() {
        assert_eq!(
            classify_relay_failure("List devices failed: HTTP 410"),
            RelayFailureKind::RelayVersionRetired
        );
        assert_eq!(
            classify_relay_failure("relay_version_retired: This Relay version has been retired."),
            RelayFailureKind::ClientOutdated
        );
        assert_eq!(
            RelayFailureKind::RelayVersionRetired.action(),
            RelayFailureAction::CheckUpdates
        );
        assert!(!RelayFailureKind::RelayVersionRetired.is_retryable());
    }

    #[test]
    fn a_refused_build_is_an_update() {
        for message in [
            "incompatible client build: remote control requires matching client versions",
            "relay_session_history_retired",
            "This relay does not store session history; update OpenBitFun on every device to continue.",
        ] {
            assert_eq!(classify_relay_failure(message), RelayFailureKind::ClientOutdated, "{message}");
        }
    }

    #[test]
    fn a_temporary_relay_fault_is_retryable() {
        for status in [408, 425, 429, 500, 502, 503, 504] {
            let message = format!("List devices failed: HTTP {status}");
            assert_eq!(
                classify_relay_failure(&message),
                RelayFailureKind::RelayUnavailable,
                "{status}"
            );
            assert!(RelayFailureKind::RelayUnavailable.is_retryable());
        }
    }

    #[test]
    fn authentication_failures_stay_on_the_sign_in_path() {
        assert_eq!(
            classify_relay_failure("List devices failed: HTTP 401"),
            RelayFailureKind::Auth
        );
        assert_eq!(
            classify_relay_failure("Invalid or expired token"),
            RelayFailureKind::Auth
        );
        assert_eq!(
            classify_relay_failure("Sign in to continue"),
            RelayFailureKind::Auth
        );
        assert_eq!(RelayFailureKind::Auth.action(), RelayFailureAction::SignIn);
    }

    #[test]
    fn transport_failures_are_network_and_unknown_stays_retryable() {
        assert_eq!(
            classify_relay_failure("error sending request: connection refused"),
            RelayFailureKind::Network
        );
        assert_eq!(
            classify_relay_failure("Relay connection failed: tls handshake failed"),
            RelayFailureKind::Network
        );
        assert_eq!(
            classify_relay_failure("List devices failed: HTTP 404"),
            RelayFailureKind::Unknown
        );
        assert_eq!(
            classify_relay_failure("").action(),
            RelayFailureAction::Retry
        );
    }

    #[test]
    fn the_configured_endpoint_of_another_official_release_counts_as_retired() {
        assert_eq!(classify_relay_endpoint(DEFAULT_RELAY_URL), None);
        let older = DEFAULT_RELAY_URL.replace("/v/1.0.2", "/v/1.0.1");
        assert_eq!(
            classify_relay_endpoint(&older),
            Some(RelayFailureKind::RelayVersionRetired)
        );
        assert_eq!(classify_relay_endpoint("https://example.com/relay"), None);
    }
}
