//! Retirement answers for a Relay version an operator is sunsetting.
//!
//! A version path such as `/v/1.0.1/` belongs to the edge proxy, which strips
//! the prefix before forwarding, so the relay cannot read the client's version
//! from the URL. The proxy therefore announces the prefix it serves in a
//! header, and the relay answers every managed route of a retired prefix with
//! an explicit, machine-readable `410 Gone`. Clients built before retirement
//! cannot be patched, but they no longer have to guess from a bare 404/502, and
//! current clients classify it as "update the client" instead of a network
//! fault.
//!
//! Static content and `/health` stay served: the page that explains the update
//! must still load, and operators keep their health probe.
use axum::{
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::json;
use std::sync::OnceLock;

pub(crate) const ERROR_CODE: &str = "relay_version_retired";
pub(crate) const MESSAGE: &str = "This Relay version has been retired. Update OpenBitFun on this device, then sign in again to continue.";
/// The edge proxy sets this to the version prefix it forwards, e.g. `/v/1.0.1`.
pub(crate) const SERVED_PREFIX_HEADER: &str = "x-openbitfun-relay-served-prefix";
const RETIRED_ENV: &str = "RELAY_RETIRED";
const RETIRED_PREFIXES_ENV: &str = "RELAY_RETIRED_VERSION_PREFIXES";

/// Retired-prefix admission. Empty by default: an unconfigured relay is never
/// retired, so this can only turn on through explicit operator intent.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct RetirementPolicy {
    retired: bool,
    prefixes: Vec<String>,
}

impl RetirementPolicy {
    /// Parse the operator's configuration. Kept separate from the environment
    /// read so the matching rules are testable without touching process state.
    pub(crate) fn from_values(retired: Option<&str>, prefixes: Option<&str>) -> Self {
        let retired = retired.is_some_and(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        });
        let prefixes = prefixes
            .map(|value| {
                value
                    .split(',')
                    .filter_map(normalize_prefix)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        Self { retired, prefixes }
    }

    pub(crate) fn from_env() -> Self {
        Self::from_values(
            std::env::var(RETIRED_ENV).ok().as_deref(),
            std::env::var(RETIRED_PREFIXES_ENV).ok().as_deref(),
        )
    }

    #[cfg(test)]
    pub(crate) fn retired_deployment() -> Self {
        Self {
            retired: true,
            prefixes: Vec::new(),
        }
    }

    /// Whether this request belongs to a retired Relay version.
    pub(crate) fn is_retired(&self, path: &str, headers: &HeaderMap) -> bool {
        if path == "/health" || !is_managed_path(path) {
            return false;
        }
        if self.retired {
            return true;
        }
        let Some(prefix) = headers
            .get(SERVED_PREFIX_HEADER)
            .and_then(|value| value.to_str().ok())
            .and_then(normalize_prefix)
        else {
            return false;
        };
        self.prefixes.contains(&prefix)
    }
}

/// Account, realtime and Page-function routes. Static content is served by the
/// relay itself and must keep answering while retired.
fn is_managed_path(path: &str) -> bool {
    ["/api", "/v1", "/v3", "/p"].iter().any(|prefix| {
        path == *prefix
            || path
                .strip_prefix(prefix)
                .is_some_and(|tail| tail.starts_with('/'))
    })
}

fn normalize_prefix(value: &str) -> Option<String> {
    let trimmed = value.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    Some(if trimmed.starts_with('/') {
        trimmed.to_string()
    } else {
        format!("/{trimmed}")
    })
}

/// `410 Gone` with a JSON body; usable as a route handler and directly from
/// admission, where it answers before any request body is buffered.
pub(crate) fn gone_response() -> Response {
    (
        StatusCode::GONE,
        [(header::CONTENT_TYPE, "application/json")],
        json!({"error": ERROR_CODE, "message": MESSAGE, "update_required": true}).to_string(),
    )
        .into_response()
}

/// Resolve the policy once and state it in the log, so an operator can confirm
/// retirement took effect before any traffic arrives instead of discovering it
/// in the first refusal.
pub(crate) fn announce_policy() {
    let policy = policy();
    if policy.retired || !policy.prefixes.is_empty() {
        tracing::warn!(
            retired_deployment = policy.retired,
            retired_prefixes = ?policy.prefixes,
            "Relay answers retired versions with {ERROR_CODE:?}"
        );
    } else {
        tracing::info!("No Relay version is retired on this deployment");
    }
}

fn policy() -> &'static RetirementPolicy {
    static POLICY: OnceLock<RetirementPolicy> = OnceLock::new();
    POLICY.get_or_init(RetirementPolicy::from_env)
}

/// Admission entry point used by the request middleware.
pub(crate) fn is_retired_request(path: &str, headers: &HeaderMap) -> bool {
    policy().is_retired(path, headers)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(prefix: Option<&str>) -> HeaderMap {
        let mut headers = HeaderMap::new();
        if let Some(prefix) = prefix {
            headers.insert(SERVED_PREFIX_HEADER, prefix.parse().unwrap());
        }
        headers
    }

    #[test]
    fn an_unconfigured_relay_is_never_retired() {
        let policy = RetirementPolicy::default();
        assert!(!policy.is_retired("/api/devices", &headers(Some("/v/1.0.1"))));
        assert!(!policy.is_retired("/v1/updates", &headers(None)));
    }

    #[test]
    fn the_admission_entry_point_stays_off_by_default() {
        // Retirement can only come from explicit operator configuration; a
        // relay started without it must never answer the retirement catch-all,
        // whatever prefix the edge proxy announces.
        assert!(!is_retired_request(
            "/api/devices",
            &headers(Some("/v/1.0.1"))
        ));
        assert!(!is_retired_request("/v1/updates", &headers(None)));
    }

    #[test]
    fn a_retired_deployment_answers_every_managed_route() {
        let policy = RetirementPolicy::retired_deployment();
        for path in [
            "/api/devices",
            "/api/info",
            "/v1/updates",
            "/v3/sessions/x",
            "/p",
        ] {
            assert!(policy.is_retired(path, &headers(None)), "{path}");
        }
        // The health probe and the page that explains the update keep working.
        assert!(!policy.is_retired("/health", &headers(None)));
        for path in [
            "/",
            "/index.html",
            "/assets/index-abc.js",
            "/brand/icon.png",
        ] {
            assert!(!policy.is_retired(path, &headers(None)), "{path}");
        }
    }

    #[test]
    fn only_the_announced_retired_prefixes_are_affected() {
        let policy = RetirementPolicy::from_values(None, Some("/v/1.0.1, v/1.0.0/"));
        assert_eq!(policy.prefixes, vec!["/v/1.0.1", "/v/1.0.0"]);
        assert!(policy.is_retired("/api/devices", &headers(Some("/v/1.0.1"))));
        assert!(policy.is_retired("/api/devices", &headers(Some("/v/1.0.0"))));
        // The prefix the relay currently serves stays fully functional.
        assert!(!policy.is_retired("/api/devices", &headers(Some("/v/1.0.2"))));
        assert!(!policy.is_retired("/api/devices", &headers(None)));
    }

    #[test]
    fn retirement_switches_read_truthy_values_and_ignore_noise() {
        for value in ["1", "true", "TRUE", " yes ", "on"] {
            assert!(
                RetirementPolicy::from_values(Some(value), None).retired,
                "{value}"
            );
        }
        for value in ["0", "false", "off", ""] {
            assert!(
                !RetirementPolicy::from_values(Some(value), None).retired,
                "{value}"
            );
        }
        let malformed = RetirementPolicy::from_values(None, Some(" , ,"));
        assert!(malformed.prefixes.is_empty());
        assert!(!malformed.is_retired("/api/devices", &headers(Some("/v/1.0.1"))));
    }

    #[tokio::test]
    async fn the_retirement_answer_is_machine_readable() {
        let response = gone_response();
        assert_eq!(response.status(), StatusCode::GONE);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(parsed["error"], ERROR_CODE);
        assert_eq!(parsed["update_required"], true);
        assert_eq!(parsed["message"], MESSAGE);
    }
}
