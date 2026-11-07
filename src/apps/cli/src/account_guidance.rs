//! Actionable account / Relay failure guidance for the CLI surfaces.
//!
//! The CLI has no i18n, so its copy stays in English. The raw transport detail
//! is never rendered: it stays in `tracing::{warn,debug}`. Classification is
//! owned by `openbitfun_core::service::remote_connect::relay_failure`, so this
//! module only turns one failure into a single user-facing sentence plus an
//! optional second line that is shown only when it adds information.
//!
//! This must stay free of HTTP statuses and exception text: the user only ever
//! reads what they can act on (retry, check the network, or update OpenBitFun).

use openbitfun_core::service::remote_connect::relay_failure::{
    classify_relay_endpoint, classify_relay_failure, RelayFailureKind,
};

/// No usable transport at all.
const NETWORK_SENTENCE: &str =
    "Cannot reach the relay server. Check the network connection and retry.";
/// Reachable but momentarily unable to serve.
const RELAY_UNAVAILABLE_SENTENCE: &str =
    "The relay server is temporarily unavailable. Retry in a moment.";
/// This build's Relay version is gone; only an update can help.
const UPDATE_SENTENCE: &str =
    "This OpenBitFun build is no longer served by the relay. Update OpenBitFun, then sign in again.";
/// Second line for the update kinds; it restates the one concrete action.
const UPDATE_HINT: &str = "Update OpenBitFun on this device to continue.";
/// Keeps the existing sign-in wording and flow.
const AUTH_SENTENCE: &str = "Sign in to continue.";
/// Deliberately conservative: an unrecognized failure stays retryable.
const UNKNOWN_SENTENCE: &str =
    "The relay rejected the request. Check the network or update OpenBitFun, then retry.";

/// One user-facing sentence plus an optional hint line, classified from a
/// Relay/account failure message.
pub(crate) fn account_failure_guidance(message: &str) -> (&'static str, Option<&'static str>) {
    guidance_for(classify_relay_failure(message))
}

/// Endpoint-aware variant: a configured endpoint that belongs to another
/// official release is retired by definition, so it is the sunset case even
/// when the failure text itself is generic.
pub(crate) fn account_failure_guidance_for_endpoint(
    message: &str,
    relay_url: &str,
) -> (&'static str, Option<&'static str>) {
    match classify_relay_endpoint(relay_url) {
        Some(kind) => guidance_for(kind),
        None => account_failure_guidance(message),
    }
}

/// The sentence joined with its optional hint as a newline-separated message.
pub(crate) fn account_failure_line(message: &str) -> String {
    join_guidance(account_failure_guidance(message))
}

fn join_guidance(guidance: (&'static str, Option<&'static str>)) -> String {
    match guidance {
        (sentence, Some(hint)) => format!("{sentence}\n{hint}"),
        (sentence, None) => sentence.to_string(),
    }
}

fn guidance_for(kind: RelayFailureKind) -> (&'static str, Option<&'static str>) {
    match kind {
        RelayFailureKind::Network => (NETWORK_SENTENCE, None),
        RelayFailureKind::RelayUnavailable => (RELAY_UNAVAILABLE_SENTENCE, None),
        RelayFailureKind::RelayVersionRetired | RelayFailureKind::ClientOutdated => {
            (UPDATE_SENTENCE, Some(UPDATE_HINT))
        }
        RelayFailureKind::Auth => (AUTH_SENTENCE, None),
        RelayFailureKind::Unknown => (UNKNOWN_SENTENCE, None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use openbitfun_product_domains::account::DEFAULT_RELAY_URL;

    #[test]
    fn a_retired_version_points_at_an_update() {
        for message in [
            "List devices failed: HTTP 410",
            "relay_version_retired: This Relay version has been retired.",
            "incompatible client build: remote control requires matching client versions",
        ] {
            assert_eq!(
                account_failure_guidance(message).0,
                UPDATE_SENTENCE,
                "{message}"
            );
        }
        assert_eq!(
            account_failure_guidance("List devices failed: HTTP 410").1,
            Some(UPDATE_HINT)
        );
    }

    #[test]
    fn a_temporary_relay_fault_is_retryable() {
        for status in [429, 502, 503] {
            let message = format!("List devices failed: HTTP {status}");
            assert_eq!(
                account_failure_guidance(&message).0,
                RELAY_UNAVAILABLE_SENTENCE,
                "{status}"
            );
            assert_eq!(account_failure_guidance(&message).1, None);
        }
    }

    #[test]
    fn transport_failures_are_network() {
        for message in [
            "error sending request: connection refused",
            "Relay request timed out",
            "Relay connection failed: tls handshake failed",
        ] {
            assert_eq!(
                account_failure_guidance(message).0,
                NETWORK_SENTENCE,
                "{message}"
            );
        }
    }

    #[test]
    fn auth_failures_keep_the_sign_in_sentence() {
        for message in ["Sign in to continue", "List devices failed: HTTP 401"] {
            let guidance = account_failure_guidance(message);
            assert_eq!(guidance.0, AUTH_SENTENCE, "{message}");
            assert_eq!(guidance.1, None, "{message}");
        }
    }

    #[test]
    fn an_unrecognized_failure_stays_retryable() {
        for message in ["List devices failed: HTTP 404", ""] {
            assert_eq!(
                account_failure_guidance(message).0,
                UNKNOWN_SENTENCE,
                "{message}"
            );
        }
    }

    #[test]
    fn the_endpoint_variant_prefers_a_retired_official_endpoint() {
        // `/v/1.0.2` and `/relay` are live aliases of one deployment; any other
        // `/v/<release>` path belongs to a retired deployment.
        let older = "https://remote.openbitfun.com/v/1.0.1";
        let retired = account_failure_guidance_for_endpoint("some generic error", older);
        assert_eq!(retired.0, UPDATE_SENTENCE);
        assert_eq!(retired.1, Some(UPDATE_HINT));

        // The endpoint this build targets falls back to the message itself.
        let current = account_failure_guidance_for_endpoint(
            "error sending request: connection refused",
            DEFAULT_RELAY_URL,
        );
        assert_eq!(current.0, NETWORK_SENTENCE);
    }

    #[test]
    fn the_joined_line_keeps_the_hint_on_its_own_line() {
        let line = account_failure_line("List devices failed: HTTP 410");
        assert_eq!(line, format!("{UPDATE_SENTENCE}\n{UPDATE_HINT}"));
        assert_eq!(
            account_failure_line("error sending request: connection refused"),
            NETWORK_SENTENCE
        );
    }

    #[test]
    fn no_sentence_leaks_a_status_or_exception_text() {
        let kinds = [
            RelayFailureKind::Network,
            RelayFailureKind::RelayUnavailable,
            RelayFailureKind::RelayVersionRetired,
            RelayFailureKind::ClientOutdated,
            RelayFailureKind::Auth,
            RelayFailureKind::Unknown,
        ];
        for kind in kinds {
            let (sentence, hint) = guidance_for(kind);
            for line in [Some(sentence), hint].into_iter().flatten() {
                assert!(!line.contains("HTTP "), "{line}");
                assert!(
                    !line.chars().any(|character| character.is_ascii_digit()),
                    "{line}"
                );
            }
        }
    }
}
