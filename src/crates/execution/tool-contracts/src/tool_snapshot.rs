use crate::framework::{DynamicToolInfo, ToolExposure, ToolRef, ToolRegistryItem};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolProviderIdentity {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_kind: Option<String>,
}

impl ToolProviderIdentity {
    pub fn builtin() -> Self {
        Self {
            provider_id: None,
            provider_kind: Some("builtin".to_string()),
        }
    }

    pub fn static_provider(provider_id: impl Into<String>) -> Self {
        let provider_id = provider_id.into();
        if provider_id.trim().is_empty() {
            return Self::builtin();
        }
        Self {
            provider_id: Some(provider_id),
            provider_kind: Some("static".to_string()),
        }
    }

    pub fn from_dynamic_tool_info(info: Option<&DynamicToolInfo>) -> Self {
        match info {
            Some(info) if !info.provider_id.trim().is_empty() => Self {
                provider_id: Some(info.provider_id.clone()),
                provider_kind: info
                    .provider_kind
                    .clone()
                    .or_else(|| Some("dynamic".to_string())),
            },
            _ => Self::builtin(),
        }
    }

    pub fn is_dynamic(&self) -> bool {
        self.provider_id.is_some()
            && !matches!(self.provider_kind.as_deref(), Some("builtin" | "static"))
    }

    pub fn is_static(&self) -> bool {
        matches!(self.provider_kind.as_deref(), Some("static"))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolEffectFactsSource {
    NoInputDefault,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolEffectFacts {
    pub source: ToolEffectFactsSource,
    pub readonly_by_default: bool,
    pub concurrency_safe_by_default: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCancellationContract {
    pub cooperative: bool,
    pub timeout_managed_by_tool: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ToolEffectFilter {
    pub readonly_default_only: bool,
}

impl ToolEffectFilter {
    pub fn readonly_only() -> Self {
        Self {
            readonly_default_only: true,
        }
    }

    pub fn matches_default_effects(&self, effects: ToolEffectFacts) -> bool {
        if self.readonly_default_only && !effects.readonly_by_default {
            return false;
        }
        true
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolSnapshotItem {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    #[serde(default)]
    pub output_schema: Value,
    pub short_description: String,
    pub provider: ToolProviderIdentity,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dynamic_info: Option<DynamicToolInfo>,
    pub exposure: ToolExposure,
    pub effects: ToolEffectFacts,
    pub cancellation: ToolCancellationContract,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterializedToolSnapshot {
    pub generation: u64,
    pub tools: Vec<ToolSnapshotItem>,
}

impl MaterializedToolSnapshot {
    pub fn tool(&self, name: &str) -> Option<&ToolSnapshotItem> {
        self.tools.iter().find(|tool| tool.name == name)
    }

    pub fn filter_tools_by_default_effects(
        &self,
        filter: ToolEffectFilter,
    ) -> Vec<&ToolSnapshotItem> {
        self.tools
            .iter()
            .filter(|tool| filter.matches_default_effects(tool.effects))
            .collect()
    }

    pub fn dynamic_tools(&self) -> Vec<&ToolSnapshotItem> {
        self.tools
            .iter()
            .filter(|tool| tool.provider.is_dynamic())
            .collect()
    }

    pub fn validate_call(
        &self,
        guard: &ToolCallSnapshotGuard,
    ) -> Result<(), ToolSnapshotCallError> {
        if guard.generation != self.generation {
            return Err(ToolSnapshotCallError::StaleSnapshot {
                tool_name: guard.tool_name.clone(),
                expected_generation: self.generation,
                actual_generation: guard.generation,
            });
        }
        if self.tool(&guard.tool_name).is_none() {
            return Err(ToolSnapshotCallError::UnknownTool {
                tool_name: guard.tool_name.clone(),
                generation: self.generation,
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallSnapshotGuard {
    pub tool_name: String,
    pub generation: u64,
}

impl ToolCallSnapshotGuard {
    pub fn new(tool_name: impl Into<String>, generation: u64) -> Self {
        Self {
            tool_name: tool_name.into(),
            generation,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolSnapshotCallError {
    StaleSnapshot {
        tool_name: String,
        expected_generation: u64,
        actual_generation: u64,
    },
    UnknownTool {
        tool_name: String,
        generation: u64,
    },
}

impl fmt::Display for ToolSnapshotCallError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::StaleSnapshot {
                tool_name,
                expected_generation,
                actual_generation,
            } => write!(
                formatter,
                "tool '{tool_name}' was selected from stale snapshot generation {actual_generation}; current generation is {expected_generation}"
            ),
            Self::UnknownTool {
                tool_name,
                generation,
            } => write!(
                formatter,
                "tool '{tool_name}' is not present in snapshot generation {generation}"
            ),
        }
    }
}

impl std::error::Error for ToolSnapshotCallError {}

pub async fn materialize_tool_snapshot<Tool: ToolRegistryItem + ?Sized>(
    tools: &[ToolRef<Tool>],
    generation: u64,
    static_provider_identity: impl Fn(&str) -> Option<ToolProviderIdentity>,
) -> Result<MaterializedToolSnapshot, String> {
    let mut snapshot_tools = Vec::with_capacity(tools.len());

    for tool in tools {
        let dynamic_info = tool
            .dynamic_tool_info()
            .filter(|info| !info.provider_id.trim().is_empty());
        let provider = dynamic_info
            .as_ref()
            .map(|info| ToolProviderIdentity::from_dynamic_tool_info(Some(info)))
            .or_else(|| static_provider_identity(tool.name()))
            .unwrap_or_else(ToolProviderIdentity::builtin);
        snapshot_tools.push(ToolSnapshotItem {
            name: tool.name().to_string(),
            description: tool.description().await?,
            input_schema: tool.input_schema_for_model().await,
            output_schema: tool.output_schema(),
            short_description: tool.short_description(),
            provider,
            dynamic_info,
            exposure: tool.default_exposure(),
            effects: ToolEffectFacts {
                source: ToolEffectFactsSource::NoInputDefault,
                readonly_by_default: tool.is_readonly(),
                concurrency_safe_by_default: tool.is_concurrency_safe(None),
            },
            cancellation: ToolCancellationContract {
                cooperative: true,
                timeout_managed_by_tool: tool.manages_own_execution_timeout(),
            },
        });
    }

    Ok(MaterializedToolSnapshot {
        generation,
        tools: snapshot_tools,
    })
}
