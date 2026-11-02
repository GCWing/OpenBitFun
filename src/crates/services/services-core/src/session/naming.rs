//! Compatibility for explicitly tagged, untouched legacy default titles.
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

pub fn migrate_legacy_default_title(metadata: &mut SessionMetadata) -> bool {
    if metadata.turn_count != 0 {
        return false;
    }
    let Some(custom) = metadata
        .custom_metadata
        .as_mut()
        .and_then(|v| v.as_object_mut())
    else {
        return false;
    };
    if custom.get("titleSource").and_then(|v| v.as_str()) != Some("i18n")
        || custom.get("titleUserEdited").and_then(|v| v.as_bool()) == Some(true)
    {
        return false;
    }
    let Some(key) = custom.get("titleKey").and_then(|v| v.as_str()) else {
        return false;
    };
    static TEMPLATES: std::sync::OnceLock<std::collections::HashMap<String, Vec<String>>> =
        std::sync::OnceLock::new();
    let templates = TEMPLATES.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../../../shared/session-naming/legacy-default-titles.json"
        ))
        .expect("legacy title contract")
    });
    let Some(variants) = templates.get(key) else {
        return false;
    };
    let count = custom
        .get("titleParams")
        .and_then(|v| v.get("count"))
        .and_then(|v| v.as_u64())
        .filter(|n| *n > 0 && *n <= 9_007_199_254_740_991);
    if !variants.iter().any(|template| {
        if template.contains("{{count}}") {
            count.is_some_and(|n| {
                metadata.session_name == template.replace("{{count}}", &n.to_string())
            })
        } else {
            metadata.session_name == *template
        }
    }) {
        return false;
    }
    metadata.session_name = "New Session".into();
    custom.insert("titleKey".into(), "flow-chat:session.new".into());
    custom.insert(
        "titleParams".into(),
        serde_json::json!({"defaultTitleText": "New Session"}),
    );
    // The host assigns a free slot on the next save; a legacy index is not a
    // reservation in the current reusable-number namespace.
    custom.remove("workspaceSessionNumber");
    true
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn legacy_default_requires_provenance_exact_text_and_no_turns() {
        let mut old = SessionMetadata::new(
            "old".into(),
            "New Claw Session 7".into(),
            "Claw".into(),
            "test-model".into(),
        );
        old.custom_metadata = Some(
            json!({"titleSource":"i18n", "titleKey":"flow-chat:session.newClawWithIndex", "titleParams":{"count":7}, "keep":true}),
        );
        let mut migrated: SessionMetadata =
            serde_json::from_value(serde_json::to_value(&old).unwrap()).unwrap();
        assert!(migrate_legacy_default_title(&mut migrated));
        assert_eq!(migrated.session_name, "New Session");
        assert_eq!(migrated.custom_metadata.as_ref().unwrap()["keep"], true);
        assert!(!migrate_legacy_default_title(&mut migrated));
        assert_eq!(
            serde_json::from_value::<SessionMetadata>(serde_json::to_value(&migrated).unwrap())
                .unwrap()
                .session_name,
            "New Session"
        );
        for variant in ["literal", "edited", "content", "different"] {
            let mut custom = old.clone();
            match variant {
                "literal" => custom.custom_metadata = None,
                "edited" => clear_default_title(&mut custom, true),
                "content" => custom.turn_count = 1,
                _ => custom.session_name = "My Claw research".into(),
            }
            let before = custom.session_name.clone();
            assert!(!migrate_legacy_default_title(&mut custom), "{variant}");
            assert_eq!(custom.session_name, before);
        }
    }
}
