//! Product contracts for importing external agent sessions.
//!
//! These DTOs deliberately describe the import boundary only. Ecosystem
//! adapters own their source formats; Assembly owns conversion into the
//! OpenBitFun Session storage model.

use serde::{Deserialize, Serialize};

pub const EXTERNAL_SESSION_IMPORT_SCHEMA_V1: u32 = 1;
pub const EXTERNAL_SESSION_IMPORT_ECOSYSTEM_CODEX: &str = "codex";

/// A removed local source reference. Restoring it does not copy or mutate the
/// external application's history, or any independently continued Session.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovedExternalSession {
    pub ecosystem_id: String,
    pub session_id: String,
    pub session_name: String,
    pub workspace_id: String,
    pub workspace_name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RestoreRemovedExternalSessionRequest {
    pub ecosystem_id: String,
    pub target_workspace_id: String,
    pub session_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExternalSessionStatus {
    Complete,
    Interrupted,
    Unsupported,
    Corrupt,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalSessionCandidate {
    pub candidate_id: String,
    pub ecosystem_id: String,
    pub source_session_id: String,
    pub title: Option<String>,
    /// Host-only previous prompt-derived title, used to recognize imported
    /// defaults without overwriting a locally renamed Session. Keep this out
    /// of the wire shape so older strict catalog readers remain compatible.
    #[serde(skip)]
    pub fallback_title: Option<String>,
    /// True only when the adapter read a saved source name, rather than a
    /// rollout preview. A temporarily unavailable name store cannot rename
    /// existing imports back to a prompt excerpt.
    #[serde(skip)]
    pub title_is_source_name: bool,
    pub cwd: Option<String>,
    pub created_at: Option<u64>,
    pub updated_at: Option<u64>,
    pub model_provider: Option<String>,
    pub model_name: Option<String>,
    pub turn_count: Option<usize>,
    pub file_size_bytes: u64,
    pub format_version: Option<String>,
    pub status: ExternalSessionStatus,
    pub fingerprint: String,
    /// A display-only path label. The raw host path is never required from a
    /// client in order to apply an import.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_location: Option<String>,
    /// The tracked local workspace that owns the source working directory.
    /// This is resolved by the host, never inferred from the active UI
    /// workspace.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_workspace_name: Option<String>,
    /// Existing OpenBitFun session created from this source rollout, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imported_session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalSessionImportWarning {
    pub code: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalSessionCatalog {
    pub schema_version: u32,
    pub ecosystem_id: String,
    pub source_revision: String,
    pub candidates: Vec<ExternalSessionCandidate>,
    pub diagnostics: Vec<ExternalSessionImportWarning>,
    pub next_cursor: Option<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExternalSessionImportMode {
    #[default]
    Full,
    LatestCompacted,
}

/// Neutral, non-executable history supplied by an ecosystem reader.
#[derive(Clone, Serialize)]
pub struct ExternalSessionTurn {
    pub source_turn_id: String,
    pub timestamp: u64,
    pub user_text: String,
    pub items: Vec<ExternalSessionItem>,
    pub source_event_count: usize,
    pub status: ExternalSessionStatus,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ExternalSessionItem {
    Text {
        text: String,
    },
    Thinking {
        text: String,
    },
    Tool {
        id: String,
        name: String,
        input: serde_json::Value,
        result: Option<serde_json::Value>,
        success: Option<bool>,
    },
}

#[derive(Clone)]
pub struct ExternalSessionDocument {
    pub candidate: ExternalSessionCandidate,
    pub turns: Vec<ExternalSessionTurn>,
    pub warnings: Vec<ExternalSessionImportWarning>,
}

/// Compatibility name for the original Codex-only reader boundary.
pub type CodexSessionDocument = ExternalSessionDocument;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_flat_catalog_round_trips_without_workspace_pagination_fields() {
        let legacy = serde_json::json!({
            "schemaVersion": 1, "ecosystemId": "codex", "sourceRevision": "v1",
            "candidates": [], "diagnostics": [], "nextCursor": 50
        });
        let catalog: ExternalSessionCatalog = serde_json::from_value(legacy.clone()).unwrap();
        assert_eq!(serde_json::to_value(catalog).unwrap(), legacy);
    }

    #[test]
    fn legacy_candidate_round_trips_without_workspace_annotations() {
        let legacy = serde_json::json!({
            "candidateId": "codex:session", "ecosystemId": "codex",
            "sourceSessionId": "session", "title": null, "cwd": "/project",
            "createdAt": null, "updatedAt": null, "modelProvider": null,
            "modelName": null, "turnCount": null, "fileSizeBytes": 120,
            "formatVersion": null, "status": "complete", "fingerprint": "sha256:test"
        });
        let mut candidate: ExternalSessionCandidate =
            serde_json::from_value(legacy.clone()).unwrap();
        assert!(candidate.target_workspace_id.is_none());
        assert!(candidate.target_workspace_name.is_none());
        assert!(candidate.imported_session_id.is_none());
        assert!(candidate.fallback_title.is_none());
        assert!(!candidate.title_is_source_name);
        candidate.fallback_title = Some("Previous prompt preview".into());
        candidate.title_is_source_name = true;
        assert_eq!(serde_json::to_value(candidate).unwrap(), legacy);
    }
}
