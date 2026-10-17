use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum SessionKind {
    #[default]
    Standard,
    Subagent,
    EphemeralChild,
}

/// Whether a persisted subagent session may accept another delegated turn.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum SessionContinuationPolicy {
    #[default]
    Reusable,
    FreshOnly,
}

/// Whether model reconciliation may replace the session's selected model.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum SessionModelBindingPolicy {
    #[default]
    Mutable,
    ApprovedImmutable,
    /// Selection is owned by the model-pool contract. Older runtimes must reject
    /// this policy rather than execute the legacy model projection.
    Pool,
}

/// Durable owner of the session's logical main-agent route.
///
/// External routes are resolved by Product Assembly for each turn. Persisting
/// only this provider-neutral owner prevents a missing external definition from
/// silently falling back to a same-name local mode after restart.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum SessionAgentRouteOwner {
    #[default]
    Local,
    External,
}

/// Custom-metadata key naming the subsystem that drives a persisted Session.
pub const SESSION_PROVIDER_METADATA_KEY: &str = "provider";

/// `provider` value of a Session driven by an external ACP agent.
///
/// The Runtime neither starts nor completes those Turns — the frontend
/// projection is their only writer — so persistence treats them as projected
/// history instead of a Runtime history branch.
pub const SESSION_PROVIDER_ACP: &str = "acp";

pub fn validate_session_id(session_id: &str) -> Result<(), String> {
    if session_id.is_empty() {
        return Err("session_id cannot be empty".to_string());
    }
    if session_id == "." || session_id == ".." {
        return Err("session_id cannot be '.' or '..'".to_string());
    }
    if session_id.contains('/') || session_id.contains('\\') {
        return Err("session_id cannot contain path separators".to_string());
    }
    if session_id.chars().any(char::is_control) {
        return Err("session_id cannot contain control characters".to_string());
    }
    let bytes = session_id.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return Err("session_id cannot use a drive-relative path prefix".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate_session_id;

    #[test]
    fn session_ids_are_single_safe_path_components() {
        for valid in [
            "session-1",
            "session_2",
            "A9",
            "id with space",
            "会话-1",
            "miniapp-customize:builtin-gomoku:1",
        ] {
            validate_session_id(valid).expect("valid session id");
        }
        for invalid in [
            "",
            ".",
            "..",
            "../outside",
            "a/b",
            "a\\b",
            "C:\\outside",
            "C:outside",
            "miniapp-customize:../outside:1",
            "control\0character",
        ] {
            assert!(
                validate_session_id(invalid).is_err(),
                "unsafe session id must fail: {invalid}"
            );
        }
    }
}
