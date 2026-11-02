//! Per-MiniApp presentation data. Native window authority stays with the host.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct MiniAppChrome {
    pub titlebar: MiniAppTitlebar,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct MiniAppTitlebar {
    /// Missing title follows the localized application name.
    pub title: Option<String>,
    pub show_title: bool,
    pub show_icon: bool,
    pub title_alignment: String,
    pub density: String,
    pub button_shape: String,
    /// Legacy metadata, preserved on disk. Native platforms own control placement.
    pub controls_position: String,
    /// Semantic token suffixes, never arbitrary CSS or executable markup.
    pub surface: String,
    pub foreground: String,
    pub border: String,
    pub actions: Vec<MiniAppChromeAction>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

impl Default for MiniAppTitlebar {
    fn default() -> Self {
        Self {
            title: None,
            show_title: true,
            show_icon: false,
            title_alignment: "start".into(),
            density: "comfortable".into(),
            button_shape: "rounded".into(),
            controls_position: "end".into(),
            surface: "surface-scene".into(),
            foreground: "content-primary".into(),
            border: "border-subtle".into(),
            actions: Vec::new(),
            extra: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiniAppChromeAction {
    pub id: String,
    pub label: String,
    /// Keys follow the shared MiniApp chrome icon catalog.
    pub icon: String,
    #[serde(default)]
    pub labels: BTreeMap<String, String>,
    #[serde(default = "enabled")]
    pub enabled: bool,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

fn enabled() -> bool {
    true
}

impl MiniAppChrome {
    pub fn validate(&self) -> Result<(), String> {
        let bar = &self.titlebar;
        for (field, value, choices) in [
            (
                "titleAlignment",
                bar.title_alignment.as_str(),
                &["start", "center"][..],
            ),
            (
                "density",
                bar.density.as_str(),
                &["compact", "comfortable"][..],
            ),
            (
                "buttonShape",
                bar.button_shape.as_str(),
                &["square", "rounded"][..],
            ),
            (
                "controlsPosition",
                bar.controls_position.as_str(),
                &["start", "end"][..],
            ),
            (
                "surface",
                bar.surface.as_str(),
                &[
                    "surface-scene",
                    "surface-canvas",
                    "surface-raised",
                    "surface-subtle",
                ][..],
            ),
            (
                "foreground",
                bar.foreground.as_str(),
                &["content-primary", "content-secondary", "content-muted"][..],
            ),
            (
                "border",
                bar.border.as_str(),
                &["border-subtle", "border-default", "border-strong"][..],
            ),
        ] {
            if !choices.contains(&value) {
                return Err(format!("Unsupported MiniApp chrome {field}: {value}"));
            }
        }
        let mut ids = HashSet::new();
        for action in &bar.actions {
            if action.id.trim().is_empty() || !ids.insert(&action.id) {
                return Err("MiniApp chrome action IDs must be non-empty and unique".into());
            }
            if action.label.trim().is_empty() {
                return Err("MiniApp chrome actions require an accessible label".into());
            }
            if ![
                "download", "save", "search", "settings", "refresh", "plus", "play", "stop",
                "check", "share", "help",
            ]
            .contains(&action.icon.as_str())
            {
                return Err(format!(
                    "Unsupported MiniApp chrome action icon: {}",
                    action.icon
                ));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_chrome_uses_defaults_and_roundtrips() {
        for (old, show_icon) in [
            (serde_json::json!({"titlebar":{"showTitle":false}}), false),
            (
                serde_json::json!({"titlebar":{"showTitle":false,"showIcon":true}}),
                true,
            ),
        ] {
            let chrome: MiniAppChrome = serde_json::from_value(old).unwrap();
            assert!(!chrome.titlebar.show_title);
            assert_eq!(chrome.titlebar.show_icon, show_icon);
            chrome.validate().unwrap();
            assert_eq!(
                chrome,
                serde_json::from_value(serde_json::to_value(&chrome).unwrap()).unwrap()
            );
        }
    }

    #[test]
    fn rejects_css_injection_and_duplicate_actions() {
        let mut chrome = MiniAppChrome::default();
        chrome.titlebar.surface = "url(https://example.com)".into();
        assert!(chrome.validate().is_err());
        chrome.titlebar.surface = "surface-scene".into();
        let action: MiniAppChromeAction = serde_json::from_value(
            serde_json::json!({"id":"export","label":"Export","icon":"download"}),
        )
        .unwrap();
        chrome.titlebar.actions = vec![action.clone(), action];
        assert!(chrome.validate().is_err());
    }
}
