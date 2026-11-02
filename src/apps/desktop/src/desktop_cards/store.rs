//! Persistent desktop card store.
//!
//! The file is read by older and newer builds. Cards this build cannot parse
//! are kept verbatim and written back unchanged, and an unreadable file is moved
//! aside instead of being overwritten.

use std::path::{Path, PathBuf};

use openbitfun_core::agentic::tools::desktop_card_host::{
    DesktopCardRecord, DESKTOP_CARD_STORE_VERSION,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub(crate) enum StoredCard {
    Card(Box<DesktopCardRecord>),
    Raw(Value),
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopCardsFile {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub cards: Vec<StoredCard>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

pub(crate) struct CardStore {
    path: PathBuf,
    file: DesktopCardsFile,
}

impl CardStore {
    pub(crate) fn load(path: PathBuf) -> Self {
        let file = match std::fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<DesktopCardsFile>(&bytes) {
                Ok(file) => file,
                Err(error) => {
                    let backup = corrupt_backup_path(&path);
                    log::warn!(
                        "Desktop card store is unreadable, moving it aside: path={}, backup={}, error={}",
                        path.display(),
                        backup.display(),
                        error
                    );
                    if let Err(error) = std::fs::rename(&path, &backup) {
                        log::warn!(
                            "Failed to move unreadable desktop card store aside: error={}",
                            error
                        );
                    }
                    DesktopCardsFile::default()
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                DesktopCardsFile::default()
            }
            Err(error) => {
                log::warn!(
                    "Failed to read desktop card store: path={}, error={}",
                    path.display(),
                    error
                );
                DesktopCardsFile::default()
            }
        };
        Self { path, file }
    }

    pub(crate) fn cards(&self) -> impl Iterator<Item = &DesktopCardRecord> {
        self.file.cards.iter().filter_map(|card| match card {
            StoredCard::Card(card) => Some(card.as_ref()),
            StoredCard::Raw(_) => None,
        })
    }

    pub(crate) fn card_count(&self) -> usize {
        self.cards().count()
    }

    pub(crate) fn get(&self, id: &str) -> Option<&DesktopCardRecord> {
        self.cards().find(|card| card.id == id)
    }

    pub(crate) fn get_mut(&mut self, id: &str) -> Option<&mut DesktopCardRecord> {
        self.file.cards.iter_mut().find_map(|card| match card {
            StoredCard::Card(card) if card.id == id => Some(card.as_mut()),
            _ => None,
        })
    }

    pub(crate) fn insert(&mut self, card: DesktopCardRecord) {
        self.file.cards.push(StoredCard::Card(Box::new(card)));
    }

    pub(crate) fn remove(&mut self, id: &str) -> Option<DesktopCardRecord> {
        let index = self
            .file
            .cards
            .iter()
            .position(|card| matches!(card, StoredCard::Card(card) if card.id == id))?;
        match self.file.cards.remove(index) {
            StoredCard::Card(card) => Some(*card),
            StoredCard::Raw(_) => None,
        }
    }

    pub(crate) fn snapshot(&self) -> Vec<DesktopCardRecord> {
        self.cards().cloned().collect()
    }

    pub(crate) fn save(&mut self) -> Result<(), String> {
        self.file.version = self.file.version.max(DESKTOP_CARD_STORE_VERSION);
        let bytes = serde_json::to_vec_pretty(&self.file)
            .map_err(|error| format!("Failed to serialize desktop cards: {error}"))?;
        write_atomically(&self.path, &bytes)
    }
}

fn corrupt_backup_path(path: &Path) -> PathBuf {
    let stamp = chrono::Utc::now().format("%Y%m%d%H%M%S");
    path.with_extension(format!("json.corrupt-{stamp}"))
}

fn write_atomically(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create desktop card directory: {error}"))?;
    }
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, bytes)
        .map_err(|error| format!("Failed to write desktop cards: {error}"))?;
    std::fs::rename(&temp, path).map_err(|error| format!("Failed to save desktop cards: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "openbitfun-desktop-cards-{}-{}",
            name,
            uuid::Uuid::new_v4().simple()
        ));
        dir.join("cards.json")
    }

    #[test]
    fn desktop_pinning_is_additive_and_survives_legacy_record_rewrites() {
        let legacy = json!({
            "id": "a", "title": "Note", "template": { "kind": "note", "text": "x" }
        });
        let record: DesktopCardRecord = serde_json::from_value(legacy.clone()).unwrap();
        assert!(record.always_on_top);
        assert!(!super::super::windows::desktop_pinned(&record));
        let rewritten = serde_json::to_value(record).unwrap();
        for (key, value) in legacy.as_object().unwrap() {
            assert_eq!(&rewritten[key], value);
        }

        let mut pinned = legacy;
        pinned["alwaysOnTop"] = json!(false);
        pinned["desktopPinned"] = json!(true);
        let mut record: DesktopCardRecord = serde_json::from_value(pinned).unwrap();
        assert!(super::super::windows::desktop_pinned(&record));
        record.title = "Renamed by an older client".to_string();
        let restored: DesktopCardRecord =
            serde_json::from_value(serde_json::to_value(record).unwrap()).unwrap();
        assert!(super::super::windows::desktop_pinned(&restored));
        assert_eq!(restored.extra["desktopPinned"], json!(true));
    }

    #[test]
    fn unparseable_cards_and_unknown_fields_survive_a_rewrite() {
        let path = temp_path("roundtrip");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let original = json!({
            "version": 7,
            "cards": [
                { "id": "a", "title": "Note", "template": { "kind": "note", "text": "x" } },
                { "broken": true },
            ],
            "layoutHints": { "grid": true }
        });
        std::fs::write(&path, serde_json::to_vec(&original).unwrap()).unwrap();

        let mut store = CardStore::load(path.clone());
        assert_eq!(store.card_count(), 1);
        store.get_mut("a").unwrap().title = "Renamed".to_string();
        store.save().unwrap();

        let written: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(written["version"], json!(7));
        assert_eq!(written["cards"][0]["title"], json!("Renamed"));
        assert_eq!(written["cards"][1], json!({ "broken": true }));
        assert_eq!(written["layoutHints"], json!({ "grid": true }));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn unreadable_store_is_moved_aside_not_overwritten() {
        let path = temp_path("corrupt");
        let dir = path.parent().unwrap().to_path_buf();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&path, b"{not json").unwrap();

        let mut store = CardStore::load(path.clone());
        assert_eq!(store.card_count(), 0);
        store.save().unwrap();

        let backups = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains("corrupt"))
            .count();
        assert_eq!(backups, 1);
        let _ = std::fs::remove_dir_all(dir);
    }
}
