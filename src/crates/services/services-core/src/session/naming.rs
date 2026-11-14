//! Default session title provenance.
use super::types::SessionMetadata;

/// Provenance remains valid only while the title still equals its original default.
pub fn is_default_title(metadata: &SessionMetadata) -> bool {
    let Some(custom) = metadata.custom_metadata.as_ref() else {
        return false;
    };
    metadata.turn_count == 0
        && custom.get("titleSource").and_then(|v| v.as_str()) == Some("i18n")
        && custom.get("titleKey").and_then(|v| v.as_str()) == Some("flow-chat:session.new")
        && custom.get("titleUserEdited").and_then(|v| v.as_bool()) != Some(true)
        && custom
            .get("titleParams")
            .and_then(|v| v.get("defaultTitleText"))
            .and_then(|v| v.as_str())
            == Some(metadata.session_name.as_str())
}

pub fn clear_default_title(metadata: &mut SessionMetadata, user_edited: bool) {
    let custom = metadata
        .custom_metadata
        .get_or_insert_with(|| serde_json::json!({}));
    if let Some(custom) = custom.as_object_mut() {
        custom.insert("titleSource".into(), "text".into());
        custom.remove("titleKey");
        custom.remove("titleParams");
        if user_edited {
            custom.insert("titleUserEdited".into(), true.into());
        }
    }
}
