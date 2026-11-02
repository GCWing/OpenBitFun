//! Portable workspace icon wire and persistence contracts.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const WORKSPACE_ICON_METADATA_KEY: &str = "openbitfun.workspaceIcon";
pub const WORKSPACE_ICON_VERSION: u32 = 1;
pub const WORKSPACE_ICON_COLORS: &[&str] = &[
    "default", "blue", "cyan", "green", "yellow", "orange", "red", "purple", "pink",
];
/// Stable project categories, independent of a renderer's icon library names.
pub const WORKSPACE_ICON_GLYPHS: &[&str] = &[
    "default",
    "code",
    "learning",
    "design",
    "documents",
    "research",
    "web",
    "mobile",
    "games",
    "data",
    "business",
    "tools",
    "travel",
    "food",
    "fitness",
    "music",
    "reading",
    "home",
    "finance",
    "photography",
    "pets",
    "nature",
    "shopping",
    "movies",
];

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceIconMode {
    #[default]
    Default,
    Image,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceIcon {
    pub version: u32,
    #[serde(default)]
    pub revision: u64,
    pub mode: WorkspaceIconMode,
    pub color: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub glyph: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset_id: Option<String>,
    /// Optional dark variant; asset_id remains the light and legacy fallback image.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dark_asset_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_request_id: Option<String>,
    /// Preserve additions written by a newer compatible host.
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

impl Default for WorkspaceIcon {
    fn default() -> Self {
        Self {
            version: WORKSPACE_ICON_VERSION,
            revision: 0,
            mode: WorkspaceIconMode::Default,
            color: "default".into(),
            glyph: None,
            asset_id: None,
            dark_asset_id: None,
            last_request_id: None,
            extra: BTreeMap::new(),
        }
    }
}

pub fn valid_workspace_icon_color(color: &str) -> bool {
    WORKSPACE_ICON_COLORS.contains(&color)
        || (color.len() == 7
            && color.starts_with('#')
            && color[1..].bytes().all(|b| b.is_ascii_hexdigit()))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceIconRequest {
    pub workspace_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WorkspaceIconInput {
    Default {
        color: String,
        /// Omitted by legacy controllers: retain the existing glyph.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        glyph: Option<String>,
    },
    Image {
        color: String,
        #[serde(default, rename = "dataBase64")]
        data_base64: Option<String>,
        /// Omission preserves the existing dark variant, including legacy controller writes.
        #[serde(
            default,
            rename = "darkDataBase64",
            skip_serializing_if = "Option::is_none"
        )]
        dark_data_base64: Option<String>,
    },
    Reset,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetWorkspaceIconRequest {
    pub workspace_id: String,
    pub expected_revision: u64,
    pub request_id: String,
    pub icon: WorkspaceIconInput,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceIconSnapshot {
    /// The main project's id when a worktree inherits its icon.
    pub workspace_id: String,
    pub icon: WorkspaceIcon,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_data: Option<String>,
    pub image_unavailable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dark_image_data: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub dark_image_unavailable: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub supports_themed_images: bool,
    /// An additive capability offer. Older hosts omit it and remain color/image-only.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub supported_glyphs: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn color_contract_rejects_css_and_accepts_palette_and_hex() {
        for value in ["default", "blue", "#a1B2c3"] {
            assert!(valid_workspace_icon_color(value));
        }
        for value in ["url(x)", "red;", "#123", "#gg0000", ""] {
            assert!(!valid_workspace_icon_color(value));
        }
    }
    #[test]
    fn compatible_unknown_fields_survive_round_trip() {
        let mut value = serde_json::to_value(WorkspaceIcon::default()).unwrap();
        value["future"] = serde_json::json!({"keep": true});
        let record: WorkspaceIcon = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(record).unwrap(), value);
    }
    #[test]
    fn legacy_payloads_and_unknown_future_glyphs_remain_readable() {
        let input = serde_json::json!({"kind": "default", "color": "blue"});
        let decoded: WorkspaceIconInput = serde_json::from_value(input.clone()).unwrap();
        assert!(matches!(
            &decoded,
            WorkspaceIconInput::Default { glyph: None, .. }
        ));
        assert_eq!(serde_json::to_value(decoded).unwrap(), input);
        let legacy_image =
            serde_json::json!({"kind": "image", "color": "blue", "dataBase64": "light"});
        let decoded: WorkspaceIconInput = serde_json::from_value(legacy_image.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), legacy_image);
        let legacy = serde_json::json!({"workspaceId": "project", "icon": {
            "version": 1, "revision": 0, "mode": "default", "color": "blue"
        }, "imageUnavailable": false});
        let decoded: WorkspaceIconSnapshot = serde_json::from_value(legacy.clone()).unwrap();
        assert!(decoded.icon.glyph.is_none());
        assert!(decoded.supported_glyphs.is_empty());
        assert_eq!(serde_json::to_value(decoded).unwrap(), legacy);
        let mut future = legacy;
        future["icon"]["glyph"] = "future-category".into();
        let decoded: WorkspaceIconSnapshot = serde_json::from_value(future.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), future);
    }
}
