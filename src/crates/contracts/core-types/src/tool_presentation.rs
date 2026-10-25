use serde::{Deserialize, Deserializer, Serialize};

/// How the model is presented with tools for a session.
///
/// This is intentionally independent from the Agent harness mode. A session
/// freezes the value when it is created so changing the global default only
/// affects sessions created afterwards.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolPresentationMode {
    Native,
    Ptc,
}

impl Default for ToolPresentationMode {
    fn default() -> Self {
        Self::Native
    }
}

impl<'de> Deserialize<'de> for ToolPresentationMode {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "ptc" => Self::Ptc,
            // Unknown values come from a newer build. Keep the session/config
            // readable and fail closed to the legacy native presentation.
            _ => Self::Native,
        })
    }
}

impl ToolPresentationMode {
    pub const fn is_native(&self) -> bool {
        matches!(self, Self::Native)
    }

    pub const fn is_ptc(&self) -> bool {
        matches!(self, Self::Ptc)
    }
}

#[cfg(test)]
mod tests {
    use super::ToolPresentationMode;

    #[test]
    fn tool_presentation_mode_uses_stable_snake_case_values() {
        assert_eq!(
            ToolPresentationMode::default(),
            ToolPresentationMode::Native
        );
        assert_eq!(
            serde_json::to_value(ToolPresentationMode::Native).unwrap(),
            "native"
        );
        assert_eq!(
            serde_json::to_value(ToolPresentationMode::Ptc).unwrap(),
            "ptc"
        );
        assert_eq!(
            serde_json::from_value::<ToolPresentationMode>(serde_json::json!("ptc")).unwrap(),
            ToolPresentationMode::Ptc
        );
        assert_eq!(
            serde_json::from_value::<ToolPresentationMode>(serde_json::json!("future_mode"))
                .unwrap(),
            ToolPresentationMode::Native
        );
    }
}
