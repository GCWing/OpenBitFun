//! Stable product-search contracts shared by product hosts and runtime ports.
//!
//! The search index is derived data. Documents deliberately contain only
//! presentation-safe session facts and visible user/assistant transcript text.

use serde::{Deserialize, Serialize};

pub const PRODUCT_SEARCH_CAPABILITY_ID: &str = "product.search.v1";
pub const DEFAULT_SESSION_CONTENT_SEARCH_LIMIT: usize = 40;
pub const MAX_SESSION_CONTENT_SEARCH_LIMIT: usize = 100;
pub const MAX_SESSION_CONTENT_SEARCH_QUERY_CHARS: usize = 512;

fn default_search_limit() -> usize {
    DEFAULT_SESSION_CONTENT_SEARCH_LIMIT
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct SessionContentSearchRequest {
    /// Owning workspace ID. Authoritative when present; `workspace_path` is
    /// then only a legacy projection for older peers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    pub workspace_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
    pub query: String,
    #[serde(default = "default_search_limit")]
    pub limit: usize,
    #[serde(default)]
    pub include_archived: bool,
}

impl SessionContentSearchRequest {
    pub fn normalized_limit(&self) -> usize {
        self.limit.clamp(1, MAX_SESSION_CONTENT_SEARCH_LIMIT)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum SessionSearchHitKind {
    Session,
    Message,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum SessionSearchMatchField {
    Title,
    Tags,
    UserMessage,
    AssistantMessage,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct SessionSearchHit {
    pub kind: SessionSearchHitKind,
    pub matched_field: SessionSearchMatchField,
    pub session_id: String,
    pub session_title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    /// Zero-based visible Turn ordinal within the Session.
    pub turn_index: Option<usize>,
    pub snippet: String,
    pub archived: bool,
    pub updated_at_ms: i64,
    /// Provider-local relevance in the inclusive 0..=100 range.
    pub score: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum SessionSearchDiagnosticCode {
    SessionUnreadable,
    SessionIndexStale,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct SessionSearchDiagnostic {
    pub code: SessionSearchDiagnosticCode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct SessionContentSearchResponse {
    pub hits: Vec<SessionSearchHit>,
    #[serde(default)]
    pub truncated: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub diagnostics: Vec<SessionSearchDiagnostic>,
}

/// Presentation-safe metadata supplied to the derived search index.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSearchSessionDocument {
    pub session_id: String,
    pub title: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub archived: bool,
    pub updated_at_ms: i64,
    /// Revision of the authoritative persisted session facts.
    pub source_revision: String,
}

/// Visible transcript text supplied to the derived search index.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSearchTurnDocument {
    pub session_id: String,
    pub turn_id: String,
    pub turn_index: usize,
    #[serde(default)]
    pub user_text: String,
    #[serde(default)]
    pub assistant_text: String,
    pub updated_at_ms: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_request_defaults_remain_tolerant() {
        let request: SessionContentSearchRequest = serde_json::from_value(serde_json::json!({
            "workspacePath": "/workspace",
            "query": "search"
        }))
        .expect("request");

        assert_eq!(request.limit, DEFAULT_SESSION_CONTENT_SEARCH_LIMIT);
        assert!(!request.include_archived);
        assert_eq!(
            request.normalized_limit(),
            DEFAULT_SESSION_CONTENT_SEARCH_LIMIT
        );
    }

    #[test]
    fn request_limit_is_bounded_at_the_contract_boundary() {
        let request = SessionContentSearchRequest {
            workspace_id: None,
            workspace_path: "/workspace".to_string(),
            remote_connection_id: None,
            remote_ssh_host: None,
            query: "search".to_string(),
            limit: usize::MAX,
            include_archived: false,
        };

        assert_eq!(request.normalized_limit(), MAX_SESSION_CONTENT_SEARCH_LIMIT);
    }
}
