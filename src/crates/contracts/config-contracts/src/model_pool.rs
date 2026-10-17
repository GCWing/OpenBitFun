//! Model pool definitions and typed Agent selections persisted in the main AI configuration.

use openbitfun_core_types::model_pool::ModelPoolStrategy;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ModelPoolDefinition {
    pub id: String,
    pub name: String,
    /// Keep the original string so a newer strategy survives an older writer.
    pub strategy: String,
    #[serde(default)]
    pub member_model_ids: Vec<String>,
    #[serde(flatten)]
    pub extensions: BTreeMap<String, serde_json::Value>,
}

impl ModelPoolDefinition {
    pub fn strategy_kind(&self) -> ModelPoolStrategy {
        match self.strategy.as_str() {
            "ordered" => ModelPoolStrategy::Ordered,
            "balanced" => ModelPoolStrategy::Balanced,
            _ => ModelPoolStrategy::Unsupported,
        }
    }

    /// Validate writes, never discard an unreadable record during recovery.
    pub fn validate(&self) -> Result<(), String> {
        if self.id.trim().is_empty() || self.name.trim().is_empty() {
            return Err("Model pool ID and name are required".into());
        }
        if self.strategy_kind() == ModelPoolStrategy::Unsupported {
            return Err("Unsupported model pool strategy".into());
        }
        let mut ids = HashSet::new();
        for id in &self.member_model_ids {
            if id.trim().is_empty()
                || matches!(id.as_str(), "primary" | "fast" | "auto" | "default")
            {
                return Err("Pool members must reference concrete model configurations".into());
            }
            if !ids.insert(id) {
                return Err("A model configuration cannot appear twice in a pool".into());
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ModelPoolDocument {
    pub version: u32,
    /// Raw records preserve malformed and future entries for repair/export.
    #[serde(default)]
    pub pools: Vec<serde_json::Value>,
    #[serde(flatten)]
    pub extensions: BTreeMap<String, serde_json::Value>,
}

impl Default for ModelPoolDocument {
    fn default() -> Self {
        Self {
            version: 1,
            pools: Vec::new(),
            extensions: BTreeMap::new(),
        }
    }
}

/// New selection fields never extend the legacy SubagentModelSelection enum.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentModelSelection {
    Model { model_ref: String },
    Pool { pool_id: String },
    Inherit,
}

impl From<crate::types::SubagentModelSelection> for AgentModelSelection {
    fn from(value: crate::types::SubagentModelSelection) -> Self {
        match value {
            crate::types::SubagentModelSelection::Fixed { model_id } => Self::Model {
                model_ref: model_id,
            },
            crate::types::SubagentModelSelection::Inherit => Self::Inherit,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubagentModelSelections {
    pub default: AgentModelSelection,
    pub builtin: BTreeMap<String, AgentModelSelection>,
    pub fork: AgentModelSelection,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentModelSelections {
    pub mode: openbitfun_core_types::model_pool::ModelSelection,
    pub subagents: SubagentModelSelections,
}

impl AgentModelSelections {
    pub fn validate_shape(&self) -> Result<(), String> {
        fn valid(selection: &AgentModelSelection) -> bool {
            match selection {
                AgentModelSelection::Model { model_ref } => !model_ref.trim().is_empty(),
                AgentModelSelection::Pool { pool_id } => !pool_id.trim().is_empty(),
                AgentModelSelection::Inherit => true,
            }
        }
        let mode_valid = match &self.mode {
            openbitfun_core_types::model_pool::ModelSelection::Model { model_ref } => {
                !model_ref.trim().is_empty()
            }
            openbitfun_core_types::model_pool::ModelSelection::Pool { pool_id } => {
                !pool_id.trim().is_empty()
            }
        };
        if !mode_valid
            || !valid(&self.subagents.default)
            || !valid(&self.subagents.fork)
            || !self.subagents.builtin.values().all(valid)
        {
            return Err(
                "Agent model selections must have non-empty model or pool references".into(),
            );
        }
        Ok(())
    }

    pub fn builtin(&self, id: &str) -> AgentModelSelection {
        self.subagents
            .builtin
            .get(id)
            .unwrap_or(&self.subagents.default)
            .clone()
    }
}

/// Preserve explicit null/invalid data instead of treating it as an absent field.
pub(crate) fn deserialize_model_selections<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<serde_json::Value>, D::Error> {
    serde_json::Value::deserialize(deserializer).map(Some)
}

impl Default for AgentModelSelections {
    fn default() -> Self {
        Self {
            mode: openbitfun_core_types::model_pool::ModelSelection::Model {
                model_ref: "primary".into(),
            },
            subagents: SubagentModelSelections {
                default: AgentModelSelection::Model {
                    model_ref: "fast".into(),
                },
                builtin: BTreeMap::from([(
                    "ResearchSpecialist".into(),
                    AgentModelSelection::Inherit,
                )]),
                fork: AgentModelSelection::Inherit,
            },
        }
    }
}

impl AgentModelSelections {
    pub fn from_legacy(legacy: &crate::types::AgentModelDefaultsConfig) -> Self {
        Self {
            mode: openbitfun_core_types::model_pool::ModelSelection::Model {
                model_ref: legacy.mode.clone(),
            },
            subagents: SubagentModelSelections {
                default: legacy.subagents.default_selection.clone().into(),
                builtin: legacy
                    .subagents
                    .builtin
                    .iter()
                    .map(|(id, choice)| (id.clone(), choice.clone().into()))
                    .collect(),
                fork: legacy.subagents.fork.clone().into(),
            },
        }
    }
}

impl crate::types::AIConfig {
    /// Read only initialized typed selections. Loading/import owns legacy migration;
    /// missing or malformed runtime data must never fall back to legacy defaults.
    pub fn effective_model_selections(&self) -> Result<AgentModelSelections, String> {
        let value = self.agent_model_selections.as_ref().ok_or_else(|| {
            "Missing ai.agent_model_selections; initialize configuration before runtime use"
                .to_string()
        })?;
        let selections: AgentModelSelections = serde_json::from_value(value.clone())
            .map_err(|error| format!("Invalid ai.agent_model_selections: {error}"))?;
        selections.validate_shape()?;
        Ok(selections)
    }

    /// Scalar-only surfaces must explicitly handle a pool instead of reading stale legacy defaults.
    pub fn mode_model_reference(&self) -> Result<String, String> {
        match self.effective_model_selections()?.mode {
            openbitfun_core_types::model_pool::ModelSelection::Model { model_ref } => Ok(model_ref),
            openbitfun_core_types::model_pool::ModelSelection::Pool { .. } => Err(
                "The default selection is a model pool; this operation requires a specific model"
                    .into(),
            ),
        }
    }

    pub fn set_model_selections(&mut self, selections: AgentModelSelections) -> Result<(), String> {
        selections.validate_shape()?;
        self.agent_model_selections =
            Some(serde_json::to_value(selections).map_err(|error| error.to_string())?);
        Ok(())
    }

    pub fn migrate_model_selections(&mut self) -> Result<bool, String> {
        if self.agent_model_selections.is_some() {
            return Ok(false);
        }
        self.set_model_selections(AgentModelSelections::from_legacy(
            &self.agent_model_defaults,
        ))?;
        Ok(true)
    }
}

impl ModelPoolDocument {
    pub fn get(&self, id: &str) -> Result<ModelPoolDefinition, String> {
        if self.version != 1 {
            return Err(format!(
                "Unsupported model pool schema version: {}",
                self.version
            ));
        }
        let mut matches = self
            .pools
            .iter()
            .filter(|value| value.get("id").and_then(serde_json::Value::as_str) == Some(id));
        let value = matches
            .next()
            .ok_or_else(|| format!("Model pool not found: {id}"))?;
        if matches.next().is_some() {
            return Err(format!("Duplicate model pool ID: {id}"));
        }
        let pool: ModelPoolDefinition = serde_json::from_value(value.clone())
            .map_err(|e| format!("Model pool needs repair: {id}: {e}"))?;
        pool.validate()?;
        Ok(pool)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn runtime_reads_require_explicit_initialization() {
        let mut ai: crate::types::AIConfig = serde_json::from_value(json!({
            "agent_model_defaults": {"mode": "legacy-model"}
        }))
        .unwrap();
        let before = serde_json::to_value(&ai).unwrap();
        assert!(ai
            .effective_model_selections()
            .unwrap_err()
            .contains("Missing"));
        assert!(ai.mode_model_reference().is_err());
        assert_eq!(serde_json::to_value(&ai).unwrap(), before);

        assert!(ai.migrate_model_selections().unwrap());
        ai.agent_model_defaults.mode = "changed-legacy-model".into();
        assert_eq!(ai.mode_model_reference().unwrap(), "legacy-model");
        assert!(!ai.migrate_model_selections().unwrap());
    }

    #[test]
    fn migration_preserves_legacy_and_new_selections_are_authoritative() {
        let mut ai = crate::types::AIConfig::default();
        ai.agent_model_defaults.mode = "original".into();
        let legacy = serde_json::to_value(&ai.agent_model_defaults).unwrap();
        assert!(ai.migrate_model_selections().unwrap());
        let mut typed = ai.effective_model_selections().unwrap();
        assert_eq!(
            typed.mode,
            openbitfun_core_types::model_pool::ModelSelection::Model {
                model_ref: "original".into()
            }
        );
        typed.mode = openbitfun_core_types::model_pool::ModelSelection::Pool {
            pool_id: "p".into(),
        };
        typed.subagents.default = AgentModelSelection::Pool {
            pool_id: "p".into(),
        };
        typed.subagents.builtin.clear();
        ai.set_model_selections(typed.clone()).unwrap();
        assert!(!ai.migrate_model_selections().unwrap());
        assert_eq!(
            serde_json::to_value(&ai.agent_model_defaults).unwrap(),
            legacy
        );
        assert_eq!(ai.effective_model_selections().unwrap(), typed);
        let saved = serde_json::to_value(&ai).unwrap();
        let loaded: crate::types::AIConfig = serde_json::from_value(saved.clone()).unwrap();
        assert_eq!(loaded.effective_model_selections().unwrap(), typed);
        #[derive(Deserialize)]
        struct LegacyReader {
            agent_model_defaults: crate::types::AgentModelDefaultsConfig,
        }
        let old: LegacyReader = serde_json::from_value(saved).unwrap();
        assert_eq!(
            serde_json::to_value(old.agent_model_defaults).unwrap(),
            legacy
        );
        typed.mode = openbitfun_core_types::model_pool::ModelSelection::Model {
            model_ref: "new".into(),
        };
        ai.set_model_selections(typed).unwrap();
        assert_eq!(
            serde_json::to_value(&ai.agent_model_defaults).unwrap(),
            legacy
        );
    }

    #[test]
    fn malformed_new_selection_is_retained_and_never_read_as_legacy() {
        for malformed in [json!(null), json!({}), json!({"mode":{"kind":"future"}})] {
            let mut value = serde_json::to_value(crate::types::AIConfig::default()).unwrap();
            value["agent_model_selections"] = malformed.clone();
            let mut ai: crate::types::AIConfig = serde_json::from_value(value).unwrap();
            assert!(ai.effective_model_selections().is_err());
            assert!(!ai.migrate_model_selections().unwrap());
            assert_eq!(
                serde_json::to_value(ai).unwrap()["agent_model_selections"],
                malformed
            );
        }
    }

    #[test]
    fn future_and_malformed_records_round_trip_without_loss() {
        let value = json!({"version":1,"future":{"flag":true},"pools":[
            {"id":"p","name":"Pool","strategy":"future","futurePolicy":9},
            {"id":"broken","member_model_ids":false}
        ]});
        let document: ModelPoolDocument = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(&document).unwrap(), value);
        let pool: ModelPoolDefinition = serde_json::from_value(document.pools[0].clone()).unwrap();
        assert_eq!(pool.strategy_kind(), ModelPoolStrategy::Unsupported);
        assert!(pool.validate().is_err());
        assert_eq!(serde_json::to_value(pool).unwrap()["futurePolicy"], 9);
    }

    #[test]
    fn minimal_record_defaults_and_member_validation() {
        let mut pool: ModelPoolDefinition = serde_json::from_value(json!({
            "id":"p","name":"Pool","strategy":"ordered"
        }))
        .unwrap();
        assert!(pool.validate().is_ok());
        pool.member_model_ids = vec!["primary".into()];
        assert!(pool.validate().is_err());
        pool.member_model_ids = vec!["a".into(), "a".into()];
        assert!(pool.validate().is_err());
        pool.member_model_ids = vec!["a".into(), "b".into()];
        assert!(pool.validate().is_ok());
        let saved = serde_json::to_value(&pool).unwrap();
        assert_eq!(
            saved,
            json!({
                "id": "p", "name": "Pool", "strategy": "ordered",
                "member_model_ids": ["a", "b"]
            })
        );
        assert_eq!(
            serde_json::from_value::<ModelPoolDefinition>(saved).unwrap(),
            pool
        );
    }
}
