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
    /// PTC backed by Python. The legacy `ptc` value remains TypeScript.
    PtcPython,
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
            "ptc_python" => Self::PtcPython,
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
        matches!(self, Self::Ptc | Self::PtcPython)
    }

    pub const fn is_ptc_python(&self) -> bool {
        matches!(self, Self::PtcPython)
    }

    pub const fn language(&self) -> PtcLanguage {
        if self.is_ptc_python() {
            PtcLanguage::Python
        } else {
            PtcLanguage::TypeScript
        }
    }
}

/// Source language used by a PTC program.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PtcLanguage {
    TypeScript,
    Python,
}

impl Default for PtcLanguage {
    fn default() -> Self {
        Self::TypeScript
    }
}

impl<'de> Deserialize<'de> for PtcLanguage {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "python" => Self::Python,
            _ => Self::TypeScript,
        })
    }
}

impl PtcLanguage {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::TypeScript => "typescript",
            Self::Python => "python",
        }
    }

    pub const fn is_typescript(self) -> bool {
        matches!(self, Self::TypeScript)
    }
}

#[cfg(test)]
mod tests {
    use super::{PtcLanguage, ToolPresentationMode};

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
            serde_json::from_value::<ToolPresentationMode>(serde_json::json!("ptc_python"))
                .unwrap(),
            ToolPresentationMode::PtcPython
        );
        assert_eq!(
            serde_json::from_value::<ToolPresentationMode>(serde_json::json!("future_mode"))
                .unwrap(),
            ToolPresentationMode::Native
        );
    }

    #[test]
    fn ptc_language_defaults_to_typescript_and_preserves_unknown_values() {
        assert_eq!(PtcLanguage::default(), PtcLanguage::TypeScript);
        assert_eq!(serde_json::to_value(PtcLanguage::Python).unwrap(), "python");
        assert_eq!(
            serde_json::from_value::<PtcLanguage>(serde_json::json!("future")).unwrap(),
            PtcLanguage::TypeScript
        );
    }
}
