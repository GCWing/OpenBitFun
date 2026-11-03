//! Optional project overrides. Missing fields retain the host's global defaults.

use crate::{AIConfig, ModelCapability};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct ProjectDefaultsConfig {
    pub primary_model: Option<String>,
    pub fast_model: Option<String>,
    pub mode: Option<String>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl ProjectDefaultsConfig {
    /// Apply only to a request-local AI projection, never to global configuration.
    pub fn apply_model_defaults(&self, ai: &mut AIConfig) -> Result<(), String> {
        for (slot, selected) in [("primary", &self.primary_model), ("fast", &self.fast_model)] {
            if let Some(id) = selected {
                if !ai.models.iter().any(|model| {
                    model.id == *id
                        && model.enabled
                        && model.supports_capability(ModelCapability::TextChat)
                }) {
                    return Err(format!("Project {slot} model is unavailable: {id}"));
                }
            }
        }
        if let Some(id) = &self.primary_model {
            ai.default_models.primary = Some(id.clone());
            let mut selections = ai.effective_model_selections()?;
            selections.mode = openbitfun_core_types::model_pool::ModelSelection::Model {
                model_ref: "primary".into(),
            };
            ai.set_model_selections(selections)?;
        }
        if let Some(id) = &self.fast_model {
            ai.default_models.fast = Some(id.clone());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AIModelConfig, AppConfig, GlobalConfig};
    use serde_json::json;

    #[test]
    fn project_defaults_legacy_and_future_fields_round_trip() {
        let mut legacy = serde_json::to_value(GlobalConfig::default()).unwrap();
        legacy["app"]
            .as_object_mut()
            .unwrap()
            .remove("project_defaults");
        let mut upgraded: GlobalConfig = serde_json::from_value(legacy).unwrap();
        assert!(upgraded.app.project_defaults.is_empty());
        upgraded.app.project_defaults.insert(
            "ssh-project".into(),
            serde_json::from_value(json!({
                "primary_model": "project-main", "mode": "Ultimate", "future": { "keep": true }
            }))
            .unwrap(),
        );
        let app: AppConfig =
            serde_json::from_value(serde_json::to_value(upgraded.app).unwrap()).unwrap();
        assert_eq!(app.project_defaults["ssh-project"].fast_model, None);
        assert_eq!(
            app.project_defaults["ssh-project"].extra["future"],
            json!({ "keep": true })
        );
        #[derive(Serialize, Deserialize)]
        struct LegacyApp {
            language: String,
            telemetry: bool,
        }
        let old: LegacyApp = serde_json::from_value(serde_json::to_value(&app).unwrap()).unwrap();
        let round_trip: AppConfig =
            serde_json::from_value(serde_json::to_value(old).unwrap()).unwrap();
        assert_eq!(round_trip.language, app.language);
        assert_eq!(round_trip.telemetry, app.telemetry);
        assert!(round_trip.project_defaults.is_empty());
    }

    #[test]
    fn project_defaults_override_slots_without_mutating_global_or_explicit_models() {
        let mut global = AIConfig::default();
        global.migrate_model_selections().unwrap();
        global.models = ["global-main", "project-main", "project-fast"]
            .into_iter()
            .map(|id| AIModelConfig {
                id: id.into(),
                enabled: true,
                ..Default::default()
            })
            .collect();
        global.default_models.primary = Some("global-main".into());
        let defaults = ProjectDefaultsConfig {
            primary_model: Some("project-main".into()),
            fast_model: Some("project-fast".into()),
            ..Default::default()
        };
        let mut scoped = global.clone();
        defaults.apply_model_defaults(&mut scoped).unwrap();
        assert_eq!(
            scoped.resolve_model_selection("primary").as_deref(),
            Some("project-main")
        );
        assert_eq!(
            scoped.resolve_model_selection("fast").as_deref(),
            Some("project-fast")
        );
        assert_eq!(
            scoped.resolve_model_selection("global-main").as_deref(),
            Some("global-main")
        );
        assert_eq!(
            global.resolve_model_selection("primary").as_deref(),
            Some("global-main")
        );
        assert_eq!(scoped.mode_model_reference().unwrap(), "primary");
        let mut missing = defaults;
        missing.fast_model = Some("deleted".into());
        assert!(missing
            .apply_model_defaults(&mut scoped)
            .unwrap_err()
            .contains("deleted"));
    }
}
