//! Agent and subagent registry owner decisions.

use crate::prompt::UserContextPolicy;
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::collections::HashSet;

pub const STANDARD_HARNESS_PROMPT_TEMPLATE: &str = "agentic_mode";
pub const STANDARD_HARNESS_CONFIG_ID: &str = "Standard";
pub const STANDARD_HARNESS_CONFIG_LABEL: &str = "Standard";
pub const STANDARD_HARNESS_CONFIG_MEMBERS: &[&str] = &["Standard"];
pub const SWARM_PLANNER_AGENT_TYPES: &[&str] = &["Ultimate", "SwarmPlanner"];
pub const SWARM_DELEGATE_AGENT_TYPES: &[&str] = &["SwarmPlanner", "SwarmWorker", "SwarmReviewer"];

pub fn is_swarm_planner_agent_type(agent_type: &str) -> bool {
    SWARM_PLANNER_AGENT_TYPES.contains(&agent_type.trim())
}

pub fn is_swarm_delegate_agent_type(agent_type: &str) -> bool {
    SWARM_DELEGATE_AGENT_TYPES.contains(&agent_type.trim())
}

pub fn resolve_mode_config_profile_id<'a>(mode_id: &'a str) -> Cow<'a, str> {
    Cow::Borrowed(openbitfun_core_types::agent_identity::canonical_agent_config_id(mode_id))
}

pub fn mode_config_profile_member_mode_ids(profile_id: &str) -> &'static [&'static str] {
    match profile_id.trim() {
        STANDARD_HARNESS_CONFIG_ID => STANDARD_HARNESS_CONFIG_MEMBERS,
        _ => &[],
    }
}

pub fn mode_config_profile_label(profile_id: &str) -> Option<&'static str> {
    match profile_id.trim() {
        STANDARD_HARNESS_CONFIG_ID => Some(STANDARD_HARNESS_CONFIG_LABEL),
        _ => None,
    }
}

pub fn mode_presentation_rank(mode_id: &str) -> u8 {
    match mode_id {
        "Standard" => 0,
        "Cowork" => 1,
        "DeepResearch" => 2,
        "Ultimate" => 3,
        "Creative" => 4,
        _ => 99,
    }
}

pub fn standard_harness_user_context_policy() -> UserContextPolicy {
    UserContextPolicy::empty()
        .with_workspace_context()
        .with_workspace_instructions()
        .with_project_layout()
        .with_memory_summary()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BuiltinAgentCategory {
    Mode,
    SubAgent,
    Hidden,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuiltinAgentDefinitionSpec {
    pub id: &'static str,
    pub category: BuiltinAgentCategory,
    pub visibility_policy: SubagentVisibilityPolicy,
    pub default_model_id: &'static str,
}

pub fn builtin_agent_definition_specs() -> Vec<BuiltinAgentDefinitionSpec> {
    use BuiltinAgentCategory::{Hidden, Mode, SubAgent};

    vec![
        builtin_agent_spec(
            "Minimal",
            Mode,
            "primary",
            SubagentVisibilityPolicy::default(),
        ),
        builtin_agent_spec(
            "Standard",
            Mode,
            "primary",
            SubagentVisibilityPolicy::default(),
        ),
        builtin_agent_spec(
            "Cowork",
            Mode,
            "primary",
            SubagentVisibilityPolicy::default(),
        ),
        builtin_agent_spec(
            "Creative",
            Mode,
            "primary",
            SubagentVisibilityPolicy::default(),
        ),
        builtin_agent_spec("Claw", Mode, "primary", SubagentVisibilityPolicy::default()),
        builtin_agent_spec(
            "DeepResearch",
            Mode,
            "primary",
            SubagentVisibilityPolicy::default(),
        ),
        builtin_agent_spec(
            "Ultimate",
            Mode,
            "primary",
            SubagentVisibilityPolicy::default(),
        ),
        builtin_agent_spec(
            "SwarmPlanner",
            SubAgent,
            "primary",
            SubagentVisibilityPolicy::hidden(["Ultimate", "SwarmPlanner"]),
        ),
        builtin_agent_spec(
            "SwarmWorker",
            SubAgent,
            "primary",
            SubagentVisibilityPolicy::hidden(["Ultimate", "SwarmPlanner"]),
        ),
        builtin_agent_spec(
            "SwarmReviewer",
            SubAgent,
            "fast",
            SubagentVisibilityPolicy::hidden(["Ultimate", "SwarmPlanner"]),
        ),
        builtin_agent_spec(
            "ComputerUse",
            SubAgent,
            "primary",
            SubagentVisibilityPolicy::restricted(["Claw"]),
        ),
        builtin_agent_spec(
            "Explore",
            SubAgent,
            "primary",
            SubagentVisibilityPolicy::public(),
        ),
        builtin_agent_spec(
            "GeneralPurpose",
            SubAgent,
            "primary",
            SubagentVisibilityPolicy::public(),
        ),
        builtin_agent_spec(
            "ResearchSpecialist",
            SubAgent,
            "fast",
            SubagentVisibilityPolicy::restricted(["DeepResearch"]),
        ),
        builtin_agent_spec(
            "ReviewWorker",
            SubAgent,
            "fast",
            SubagentVisibilityPolicy::restricted(["DeepReview"]),
        ),
        builtin_agent_spec(
            "ReviewJudge",
            SubAgent,
            "fast",
            SubagentVisibilityPolicy::restricted(["DeepReview"]),
        ),
        builtin_agent_spec(
            "ReviewFixer",
            SubAgent,
            "fast",
            SubagentVisibilityPolicy::hidden(["CodeReview", "DeepReview"]),
        ),
        builtin_agent_spec(
            "CodeReview",
            SubAgent,
            "primary",
            SubagentVisibilityPolicy::hidden(["Standard", "Cowork"]),
        ),
        builtin_agent_spec(
            "DeepReview",
            Hidden,
            "fast",
            SubagentVisibilityPolicy::default(),
        ),
        builtin_agent_spec(
            "GenerateDoc",
            Hidden,
            "fast",
            SubagentVisibilityPolicy::default(),
        ),
        builtin_agent_spec(
            "OpenBitFun",
            Hidden,
            "primary",
            SubagentVisibilityPolicy::default(),
        ),
        builtin_agent_spec(
            "MemoryPhase2",
            Hidden,
            "primary",
            SubagentVisibilityPolicy::default(),
        ),
    ]
}

pub fn default_model_id_for_builtin_agent(agent_type: &str) -> &'static str {
    match agent_type {
        "OpenBitFun" | "Minimal" | "Standard" | "Cowork" | "Creative" | "ComputerUse" | "Claw"
        | "DeepResearch" | "Ultimate" => "primary",
        "Explore" | "CodeReview" | "GeneralPurpose" | "MemoryPhase2" | "SwarmPlanner"
        | "SwarmWorker" => "primary",
        "GenerateDoc"
        | "ResearchSpecialist"
        | "DeepReview"
        | "ReviewWorker"
        | "ReviewBusinessLogic"
        | "ReviewGeneral"
        | "ReviewPerformance"
        | "ReviewSecurity"
        | "ReviewArchitecture"
        | "ReviewFrontend"
        | "ReviewJudge"
        | "ReviewFixer"
        | "SwarmReviewer" => "fast",
        _ => "fast",
    }
}

fn builtin_agent_spec(
    id: &'static str,
    category: BuiltinAgentCategory,
    default_model_id: &'static str,
    visibility_policy: SubagentVisibilityPolicy,
) -> BuiltinAgentDefinitionSpec {
    BuiltinAgentDefinitionSpec {
        id,
        category,
        visibility_policy,
        default_model_id,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubagentListScope {
    TaskVisible,
    RegistryManagement,
}

#[derive(Debug, Clone)]
pub struct SubagentQueryContext<'a> {
    pub parent_agent_type: Option<&'a str>,
    pub workspace_id: Option<&'a str>,
    pub list_scope: SubagentListScope,
    pub include_disabled: bool,
    /// False for remote workspaces until an explicit remote source provider is
    /// available. This prevents a matching path string from selecting local
    /// external-source routes.
    pub external_sources_supported: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BuiltinSubagentExposure {
    Public,
    Restricted,
    Hidden,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentVisibilitySummary {
    pub exposure: BuiltinSubagentExposure,
    pub allowed_parent_agent_ids: Vec<String>,
    pub denied_parent_agent_ids: Vec<String>,
    pub show_in_global_registry: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubagentVisibilityPolicy {
    pub exposure: BuiltinSubagentExposure,
    pub allowed_parent_agent_ids: HashSet<String>,
    pub denied_parent_agent_ids: HashSet<String>,
    pub show_in_global_registry: bool,
}

impl SubagentVisibilityPolicy {
    pub fn public() -> Self {
        Self {
            exposure: BuiltinSubagentExposure::Public,
            allowed_parent_agent_ids: HashSet::new(),
            denied_parent_agent_ids: HashSet::new(),
            show_in_global_registry: true,
        }
    }

    pub fn restricted<I, S>(allowed_parent_agent_ids: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self {
            exposure: BuiltinSubagentExposure::Restricted,
            allowed_parent_agent_ids: allowed_parent_agent_ids
                .into_iter()
                .map(Into::into)
                .collect(),
            denied_parent_agent_ids: HashSet::new(),
            show_in_global_registry: true,
        }
    }

    pub fn hidden<I, S>(allowed_parent_agent_ids: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self {
            exposure: BuiltinSubagentExposure::Hidden,
            allowed_parent_agent_ids: allowed_parent_agent_ids
                .into_iter()
                .map(Into::into)
                .collect(),
            denied_parent_agent_ids: HashSet::new(),
            show_in_global_registry: false,
        }
    }

    pub fn deny_for<I, S>(mut self, denied_parent_agent_ids: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.denied_parent_agent_ids = denied_parent_agent_ids
            .into_iter()
            .map(Into::into)
            .collect();
        self
    }

    pub fn summary(&self) -> SubagentVisibilitySummary {
        let mut allowed_parent_agent_ids: Vec<String> =
            self.allowed_parent_agent_ids.iter().cloned().collect();
        allowed_parent_agent_ids.sort();

        let mut denied_parent_agent_ids: Vec<String> =
            self.denied_parent_agent_ids.iter().cloned().collect();
        denied_parent_agent_ids.sort();

        SubagentVisibilitySummary {
            exposure: self.exposure,
            allowed_parent_agent_ids,
            denied_parent_agent_ids,
            show_in_global_registry: self.show_in_global_registry,
        }
    }

    pub fn can_access_from_parent(&self, parent_agent_type: Option<&str>) -> bool {
        let normalized_parent = parent_agent_type
            .map(str::trim)
            .filter(|value| !value.is_empty());

        if normalized_parent.is_some_and(|parent| self.denied_parent_agent_ids.contains(parent)) {
            return false;
        }

        match self.exposure {
            BuiltinSubagentExposure::Public => true,
            BuiltinSubagentExposure::Restricted | BuiltinSubagentExposure::Hidden => {
                normalized_parent
                    .is_some_and(|parent| self.allowed_parent_agent_ids.contains(parent))
            }
        }
    }
}

impl Default for SubagentVisibilityPolicy {
    fn default() -> Self {
        Self::public()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubagentSourceKind {
    Builtin,
    Project,
    User,
    External,
    Unspecified,
}

/// Subagent source shown to product surfaces and registry-management APIs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SubAgentSource {
    Builtin,
    Project,
    User,
    External,
}

pub const fn subagent_source_kind(source: Option<SubAgentSource>) -> SubagentSourceKind {
    match source {
        Some(SubAgentSource::Builtin) => SubagentSourceKind::Builtin,
        Some(SubAgentSource::Project) => SubagentSourceKind::Project,
        Some(SubAgentSource::User) => SubagentSourceKind::User,
        Some(SubAgentSource::External) => SubagentSourceKind::External,
        None => SubagentSourceKind::Unspecified,
    }
}

pub const fn subagent_source_presentation_rank(source: Option<SubAgentSource>) -> u8 {
    match source {
        Some(SubAgentSource::Builtin) => 0,
        Some(SubAgentSource::Project) => 1,
        Some(SubAgentSource::User) => 2,
        Some(SubAgentSource::External) => 3,
        None => 4,
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SubagentOverrideState {
    Enabled,
    Disabled,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SubagentStateReason {
    BuiltinDefaultVisible,
    BuiltinDefaultHidden,
    CustomDefaultEnabled,
    EnabledByProjectOverride,
    DisabledByProjectOverride,
    EnabledByUserOverride,
    DisabledByUserOverride,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SubagentOverrideLayers {
    pub project_override: Option<SubagentOverrideState>,
    pub user_override: Option<SubagentOverrideState>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ResolvedSubagentAvailability {
    pub default_enabled: bool,
    pub effective_enabled: bool,
    pub override_state: Option<SubagentOverrideState>,
    pub state_reason: Option<SubagentStateReason>,
}

pub fn resolve_subagent_default_enabled(
    source: SubagentSourceKind,
    visibility: &SubagentVisibilityPolicy,
    parent_agent_type: Option<&str>,
) -> bool {
    match source {
        SubagentSourceKind::Builtin => visibility.can_access_from_parent(parent_agent_type),
        SubagentSourceKind::Project
        | SubagentSourceKind::User
        | SubagentSourceKind::External
        | SubagentSourceKind::Unspecified => true,
    }
}

pub fn resolve_subagent_availability(
    source: SubagentSourceKind,
    default_enabled: bool,
    layers: SubagentOverrideLayers,
) -> ResolvedSubagentAvailability {
    if source == SubagentSourceKind::Project {
        if let Some(project_override) = layers.project_override {
            return ResolvedSubagentAvailability {
                default_enabled,
                effective_enabled: project_override == SubagentOverrideState::Enabled,
                override_state: Some(project_override),
                state_reason: Some(project_reason(project_override)),
            };
        }
    } else if matches!(
        source,
        SubagentSourceKind::Builtin | SubagentSourceKind::User
    ) {
        if let Some(user_override) = layers.user_override {
            return ResolvedSubagentAvailability {
                default_enabled,
                effective_enabled: user_override == SubagentOverrideState::Enabled,
                override_state: Some(user_override),
                state_reason: Some(user_reason(user_override)),
            };
        }
    }

    ResolvedSubagentAvailability {
        default_enabled,
        effective_enabled: default_enabled,
        override_state: None,
        state_reason: default_reason(source, default_enabled),
    }
}

const fn default_reason(
    source: SubagentSourceKind,
    default_enabled: bool,
) -> Option<SubagentStateReason> {
    match source {
        SubagentSourceKind::Builtin => Some(if default_enabled {
            SubagentStateReason::BuiltinDefaultVisible
        } else {
            SubagentStateReason::BuiltinDefaultHidden
        }),
        SubagentSourceKind::Project | SubagentSourceKind::User => {
            Some(SubagentStateReason::CustomDefaultEnabled)
        }
        SubagentSourceKind::External | SubagentSourceKind::Unspecified => None,
    }
}

const fn project_reason(state: SubagentOverrideState) -> SubagentStateReason {
    match state {
        SubagentOverrideState::Enabled => SubagentStateReason::EnabledByProjectOverride,
        SubagentOverrideState::Disabled => SubagentStateReason::DisabledByProjectOverride,
    }
}

const fn user_reason(state: SubagentOverrideState) -> SubagentStateReason {
    match state {
        SubagentOverrideState::Enabled => SubagentStateReason::EnabledByUserOverride,
        SubagentOverrideState::Disabled => SubagentStateReason::DisabledByUserOverride,
    }
}
