//! Versioned, read-only workspace resources for controller-owned HTML previews.

use serde::{Deserialize, Serialize};

pub const MAX_PREVIEW_BYTES: u64 = 64 * 1024 * 1024;
pub const PREVIEW_CHUNK_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HtmlPreviewResourceRequest {
    pub workspace_id: String,
    pub file_path: String,
    /// Decoded URL path, relative to the preview origin. None selects the entry.
    #[serde(default)]
    pub resource_path: Option<String>,
    #[serde(default)]
    pub metadata_only: bool,
    #[serde(default)]
    pub offset: u64,
    #[serde(default)]
    pub expected_source: Option<String>,
    #[serde(default)]
    pub expected_revision: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HtmlPreviewResource {
    pub entry_path: String,
    pub resource_path: String,
    /// Opaque workspace/provider binding; stable across transport reconnects.
    pub source: String,
    pub revision: String,
    pub mime_type: String,
    pub size: u64,
    pub offset: u64,
    pub content_base64: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HtmlPreviewErrorCode {
    InvalidPath,
    NotFound,
    Forbidden,
    TooLarge,
    Changed,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HtmlPreviewError {
    pub code: HtmlPreviewErrorCode,
    pub message: String,
}

impl HtmlPreviewError {
    pub fn new(code: HtmlPreviewErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::new(HtmlPreviewErrorCode::Unavailable, message)
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "status", content = "data", rename_all = "snake_case")]
pub enum HtmlPreviewResourceReply {
    File(HtmlPreviewResource),
    Error(HtmlPreviewError),
}

impl From<Result<HtmlPreviewResource, HtmlPreviewError>> for HtmlPreviewResourceReply {
    fn from(result: Result<HtmlPreviewResource, HtmlPreviewError>) -> Self {
        match result {
            Ok(file) => Self::File(file),
            Err(error) => Self::Error(error),
        }
    }
}

impl HtmlPreviewResourceReply {
    pub fn into_result(self) -> Result<HtmlPreviewResource, HtmlPreviewError> {
        match self {
            Self::File(file) => Ok(file),
            Self::Error(error) => Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minimal_request_round_trip_keeps_optional_defaults() {
        let request: HtmlPreviewResourceRequest = serde_json::from_value(serde_json::json!({
            "workspaceId": "workspace", "filePath": "/repo/dist/index.html", "future": true
        }))
        .unwrap();
        assert!(request.resource_path.is_none());
        assert_eq!(request.offset, 0);
        assert!(!request.metadata_only);
        assert!(request.expected_source.is_none());
        assert!(request.expected_revision.is_none());
        let round_trip: HtmlPreviewResourceRequest =
            serde_json::from_value(serde_json::to_value(request).unwrap()).unwrap();
        assert_eq!(round_trip.workspace_id, "workspace");
        assert_eq!(round_trip.file_path, "/repo/dist/index.html");
    }
}
