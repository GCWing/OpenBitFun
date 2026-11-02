//! Mode/profile tool configuration migration and resolution.
//!
//! Stored configuration keeps only user overrides. Effective tool lists are
//! derived from the current mode defaults at runtime.

use crate::agentic::agents::{
    get_agent_registry, mode_config_profile_member_mode_ids, resolve_mode_config_profile_id,
};
use crate::agentic::tools::registry::get_all_registered_tools;
use crate::service::config::global::GlobalConfigManager;
use crate::service::config::types::{
    AgentProfileConfig, AgentProfileView, ParentSubagentOverrideConfig,
};
use crate::util::errors::*;
use openbitfun_agent_runtime::skills::normalize_user_mode_skill_overrides;
use openbitfun_runtime_ports::PermissionRule;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};

const DYNAMIC_MCP_TOOL_PREFIX: &str = "mcp__";

/// Agent-profile config canonicalization report.
#[derive(Debug, Serialize, Deserialize, Default)]
pub struct AgentProfileConfigCanonicalizationReport {
    pub removed_profile_configs: Vec<String>,
    pub updated_profiles: Vec<AgentProfileConfigUpdateInfo>,
}

/// Agent-profile config update information.
#[derive(Debug, Serialize, Deserialize)]
pub struct AgentProfileConfigUpdateInfo {
    pub profile_id: String,
    pub added_tools: Vec<String>,
    pub removed_tools: Vec<String>,
}

fn dedupe_preserving_order(items: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();

    for item in items {
        let trimmed = item.trim();
        if trimmed.is_empty() {
            continue;
        }

        let owned = trimmed.to_string();
        if seen.insert(owned.clone()) {
            normalized.push(owned);
        }
    }

    normalized
}

fn normalize_tools(tools: Vec<String>, valid_tools: &HashSet<String>) -> Vec<String> {
    dedupe_preserving_order(tools)
        .into_iter()
        .filter(|tool| valid_tools.contains(tool))
        .collect()
}

fn normalize_added_tool_overrides(
    tools: Vec<String>,
    valid_tools: &HashSet<String>,
) -> Vec<String> {
    dedupe_preserving_order(tools)
        .into_iter()
        .filter(|tool| valid_tools.contains(tool) || tool.starts_with(DYNAMIC_MCP_TOOL_PREFIX))
        .collect()
}

fn normalize_skill_override_lists(
    disabled_user_skills: Vec<String>,
    enabled_user_skills: Vec<String>,
) -> (Vec<String>, Vec<String>) {
    let overrides = normalize_user_mode_skill_overrides(disabled_user_skills, enabled_user_skills);
    (overrides.disabled_skills, overrides.enabled_skills)
}

fn normalize_subagent_overrides(
    overrides: ParentSubagentOverrideConfig,
) -> ParentSubagentOverrideConfig {
    overrides
        .into_iter()
        .filter_map(|(subagent_key, state)| {
            let trimmed = subagent_key.trim();
            (!trimmed.is_empty()).then(|| (trimmed.to_string(), state))
        })
        .collect()
}

fn resolve_profile_id(mode_id: &str) -> String {
    resolve_mode_config_profile_id(mode_id).into_owned()
}

pub fn resolve_effective_tools(
    default_tools: &[String],
    mode_config: Option<&AgentProfileConfig>,
    valid_tools: &HashSet<String>,
) -> Vec<String> {
    let default_tools = normalize_tools(default_tools.to_vec(), valid_tools);
    let removed: HashSet<String> = mode_config
        .map(|config| config.removed_tools.iter().cloned().collect())
        .unwrap_or_default();
    let added = mode_config
        .map(|config| normalize_tools(config.added_tools.clone(), valid_tools))
        .unwrap_or_default();

    let mut effective = Vec::new();
    let mut seen = HashSet::new();

    // Keep legacy Pages overrides meaningful after the default tool is unified.
    // A previous exclusion must not silently re-enable the capability under its
    // new name; an explicit legacy opt-in keeps its narrower operation set.
    let legacy_pages_override = mode_config.is_some_and(|config| {
        config
            .removed_tools
            .iter()
            .chain(&config.added_tools)
            .any(|tool| matches!(tool.as_str(), "PagePublish" | "PageDeploy"))
    });

    for tool in default_tools {
        if removed.contains(&tool) {
            continue;
        }
        if tool == "PageManage"
            && legacy_pages_override
            && !added.iter().any(|tool| tool == "PageManage")
        {
            // A legacy exclusion selected a subset of the former two defaults.
            // Preserve that subset until the user explicitly selects PageManage.
            if removed.contains("PagePublish") || removed.contains("PageDeploy") {
                for legacy in ["PageDeploy", "PagePublish"] {
                    if !removed.contains(legacy)
                        && valid_tools.contains(legacy)
                        && seen.insert(legacy.to_string())
                    {
                        effective.push(legacy.to_string());
                    }
                }
            }
            continue;
        }
        if seen.insert(tool.clone()) {
            effective.push(tool);
        }
    }

    for tool in added {
        if seen.insert(tool.clone()) {
            effective.push(tool);
        }
    }

    effective
}

fn stored_agent_profile_from_tool_selection(
    agent_id: &str,
    enabled_tools: Vec<String>,
    disabled_user_skills: Vec<String>,
    enabled_user_skills: Vec<String>,
    subagent_overrides: ParentSubagentOverrideConfig,
    tool_permission_rules: Vec<PermissionRule>,
    default_tools: &[String],
    valid_tools: &HashSet<String>,
) -> Option<AgentProfileConfig> {
    let default_tools = normalize_tools(default_tools.to_vec(), valid_tools);
    let enabled_tools = normalize_tools(enabled_tools, valid_tools);
    let enabled_set: HashSet<String> = enabled_tools.iter().cloned().collect();
    let default_set: HashSet<String> = default_tools.iter().cloned().collect();

    let mut added_tools = Vec::new();
    for tool in &enabled_tools {
        if !default_set.contains(tool) {
            added_tools.push(tool.clone());
        }
    }

    let mut removed_tools = Vec::new();
    for tool in &default_tools {
        if !enabled_set.contains(tool) {
            removed_tools.push(tool.clone());
        }
    }

    stored_agent_profile_from_overrides(StoredAgentProfileOverrides {
        agent_id,
        added_tools,
        removed_tools,
        disabled_user_skills,
        enabled_user_skills,
        subagent_overrides,
        tool_permission_rules,
        default_tools: &default_tools,
        valid_tools,
    })
}

struct StoredAgentProfileOverrides<'a> {
    agent_id: &'a str,
    added_tools: Vec<String>,
    removed_tools: Vec<String>,
    disabled_user_skills: Vec<String>,
    enabled_user_skills: Vec<String>,
    subagent_overrides: ParentSubagentOverrideConfig,
    tool_permission_rules: Vec<PermissionRule>,
    default_tools: &'a [String],
    valid_tools: &'a HashSet<String>,
}

fn stored_agent_profile_from_overrides(
    overrides: StoredAgentProfileOverrides<'_>,
) -> Option<AgentProfileConfig> {
    let StoredAgentProfileOverrides {
        agent_id,
        added_tools,
        removed_tools,
        disabled_user_skills,
        enabled_user_skills,
        subagent_overrides,
        tool_permission_rules,
        default_tools,
        valid_tools,
    } = overrides;
    let profile_id = resolve_profile_id(agent_id);
    let default_set: HashSet<String> = default_tools.iter().cloned().collect();
    // MCP tools are registered only after deferred server initialization. Keep
    // their stored overrides during startup canonicalization even when the
    // current registry snapshot cannot validate them yet.
    let mut added_tools = normalize_added_tool_overrides(added_tools, valid_tools);
    let mut removed_tools = normalize_tools(removed_tools, valid_tools);
    let (disabled_user_skills, enabled_user_skills) =
        normalize_skill_override_lists(disabled_user_skills, enabled_user_skills);
    let subagent_overrides = normalize_subagent_overrides(subagent_overrides);

    let legacy_pages_override = added_tools
        .iter()
        .chain(&removed_tools)
        .any(|tool| matches!(tool.as_str(), "PagePublish" | "PageDeploy"));
    added_tools.retain(|tool| {
        !default_set.contains(tool) || (tool == "PageManage" && legacy_pages_override)
    });
    removed_tools.retain(|tool| {
        default_set.contains(tool)
            || (default_set.contains("PageManage")
                && matches!(tool.as_str(), "PagePublish" | "PageDeploy"))
    });
    let removed_set: HashSet<String> = removed_tools.iter().cloned().collect();
    added_tools.retain(|tool| !removed_set.contains(tool));

    if added_tools.is_empty()
        && removed_tools.is_empty()
        && disabled_user_skills.is_empty()
        && enabled_user_skills.is_empty()
        && subagent_overrides.is_empty()
        && tool_permission_rules.is_empty()
    {
        return None;
    }

    Some(AgentProfileConfig {
        profile_id,
        added_tools,
        removed_tools,
        disabled_user_skills,
        enabled_user_skills,
        subagent_overrides,
        tool_permission_rules,
        ..Default::default()
    })
}

fn retain_profile_extensions(
    profile_id: &str,
    canonical: Option<AgentProfileConfig>,
    extensions: Map<String, Value>,
) -> Option<AgentProfileConfig> {
    if extensions.is_empty() {
        return canonical;
    }
    let mut config = canonical.unwrap_or_else(|| AgentProfileConfig {
        profile_id: profile_id.to_string(),
        ..Default::default()
    });
    config.extensions = extensions;
    Some(config)
}

fn build_agent_profile_view(
    agent_id: &str,
    default_tools: Vec<String>,
    mode_config: Option<&AgentProfileConfig>,
    valid_tools: &HashSet<String>,
) -> AgentProfileView {
    let default_tools = normalize_tools(default_tools, valid_tools);
    let enabled_tools = resolve_effective_tools(&default_tools, mode_config, valid_tools);
    let (disabled_user_skills, enabled_user_skills) = mode_config
        .map(|config| {
            normalize_skill_override_lists(
                config.disabled_user_skills.clone(),
                config.enabled_user_skills.clone(),
            )
        })
        .unwrap_or_else(|| (Vec::new(), Vec::new()));

    AgentProfileView {
        profile_id: resolve_profile_id(agent_id),
        enabled_tools,
        default_tools,
        disabled_user_skills,
        enabled_user_skills,
    }
}

fn canonicalize_agent_profile(
    profile_id: &str,
    raw_mode: Option<&Value>,
    default_tools: &[String],
    valid_tools: &HashSet<String>,
) -> OpenBitFunResult<Option<AgentProfileConfig>> {
    let Some(raw_mode) = raw_mode else {
        return Ok(None);
    };
    if raw_mode.is_null() {
        return Ok(None);
    }

    let mut stored: AgentProfileConfig =
        serde_json::from_value(raw_mode.clone()).map_err(|error| {
            OpenBitFunError::config(format!(
                "Failed to deserialize agent profile '{}': {}",
                profile_id, error
            ))
        })?;
    if stored.profile_id.trim().is_empty() {
        stored.profile_id = profile_id.to_string();
    }

    let canonical = stored_agent_profile_from_overrides(StoredAgentProfileOverrides {
        agent_id: profile_id,
        added_tools: stored.added_tools,
        removed_tools: stored.removed_tools,
        disabled_user_skills: stored.disabled_user_skills,
        enabled_user_skills: stored.enabled_user_skills,
        subagent_overrides: stored.subagent_overrides,
        tool_permission_rules: stored.tool_permission_rules,
        default_tools,
        valid_tools,
    });
    Ok(retain_profile_extensions(
        profile_id,
        canonical,
        stored.extensions,
    ))
}

async fn get_valid_tool_names() -> HashSet<String> {
    get_all_registered_tools()
        .await
        .into_iter()
        .map(|tool| tool.name().to_string())
        .collect()
}

async fn get_mode_defaults() -> HashMap<String, Vec<String>> {
    get_agent_registry()
        .get_modes_info()
        .await
        .into_iter()
        .map(|mode| (mode.id, mode.default_tools))
        .collect()
}

/// Default tool lists for every agent that can own a stored profile.
///
/// Profiles are not a mode-only concept: sub-agents carry their own skill
/// selection, so a mode-only lookup rejects writes for agents the UI already
/// lets users configure (`ComputerUse` being the built-in case).
async fn get_agent_defaults() -> HashMap<String, Vec<String>> {
    let mut defaults = get_mode_defaults().await;
    for subagent in get_agent_registry().get_subagents_info(None).await {
        defaults
            .entry(subagent.id)
            .or_insert(subagent.default_tools);
    }
    defaults
}

async fn get_profile_defaults() -> HashMap<String, Vec<String>> {
    let mut defaults = HashMap::new();
    for (agent_id, default_tools) in get_agent_defaults().await {
        defaults
            .entry(resolve_profile_id(&agent_id))
            .or_insert(default_tools);
    }
    defaults
}

pub async fn get_agent_profile_configs() -> OpenBitFunResult<HashMap<String, AgentProfileConfig>> {
    let config_service = GlobalConfigManager::get_service().await?;
    let raw = config_service.get_config(Some("ai.agent_profiles")).await?;
    let mut migrated =
        openbitfun_config_contracts::agent_identity_migration::canonicalize_agent_profile_keys(
            &raw,
        )
        .map_err(OpenBitFunError::config)?;
    migrated.retain(|_, value| !value.is_null());
    let mut profiles: HashMap<String, AgentProfileConfig> =
        serde_json::from_value(Value::Object(migrated))?;
    for (id, config) in &mut profiles {
        config.profile_id = id.clone();
    }
    Ok(profiles)
}

pub async fn get_agent_profile_views() -> OpenBitFunResult<HashMap<String, AgentProfileView>> {
    let stored_configs = get_agent_profile_configs().await?;
    let mode_defaults = get_mode_defaults().await;
    let valid_tools = get_valid_tool_names().await;

    let mut views = HashMap::new();
    for (mode_id, default_tools) in mode_defaults {
        let profile_id = resolve_profile_id(&mode_id);
        let view = build_agent_profile_view(
            &mode_id,
            default_tools,
            stored_configs.get(&profile_id),
            &valid_tools,
        );
        views.insert(mode_id, view);
    }

    Ok(views)
}

pub async fn get_agent_profile_view(agent_id: &str) -> OpenBitFunResult<AgentProfileView> {
    let agent_id = openbitfun_core_types::agent_identity::canonical_agent_id(agent_id);
    let views = get_agent_profile_views().await?;
    views
        .get(agent_id)
        .cloned()
        .ok_or_else(|| OpenBitFunError::config(format!("Agent does not exist: {}", agent_id)))
}

pub async fn persist_agent_profile_from_value(
    agent_id: &str,
    config: Value,
) -> OpenBitFunResult<()> {
    let agent_id = openbitfun_core_types::agent_identity::canonical_agent_id(agent_id);
    let config_service = GlobalConfigManager::get_service().await?;
    let agent_defaults = get_agent_defaults().await;
    let default_tools = agent_defaults
        .get(agent_id)
        .ok_or_else(|| OpenBitFunError::config(format!("Agent does not exist: {}", agent_id)))?;
    let valid_tools = get_valid_tool_names().await;
    let profile_id = resolve_profile_id(agent_id);
    config_service
        .update_config(
            "ai.agent_profiles",
            |stored_configs: &mut HashMap<String, AgentProfileConfig>| {
                let current = stored_configs.get(&profile_id);

                let enabled_tools = if let Some(tools) = config.get("enabled_tools") {
                    serde_json::from_value::<Vec<String>>(tools.clone()).map_err(|error| {
                        OpenBitFunError::config(format!(
                            "Invalid enabled_tools for mode '{}': {}",
                            agent_id, error
                        ))
                    })?
                } else {
                    resolve_effective_tools(default_tools, current, &valid_tools)
                };

                let disabled_user_skills = if config
                    .as_object()
                    .map(|obj| obj.contains_key("disabled_user_skills"))
                    .unwrap_or(false)
                {
                    match config.get("disabled_user_skills") {
                        Some(Value::Null) | None => Vec::new(),
                        Some(value) => serde_json::from_value::<Vec<String>>(value.clone())
                            .map_err(|error| {
                                OpenBitFunError::config(format!(
                                    "Invalid disabled_user_skills for mode '{}': {}",
                                    agent_id, error
                                ))
                            })?,
                    }
                } else {
                    current
                        .map(|item| item.disabled_user_skills.clone())
                        .unwrap_or_default()
                };

                let enabled_user_skills = if config
                    .as_object()
                    .map(|obj| obj.contains_key("enabled_user_skills"))
                    .unwrap_or(false)
                {
                    match config.get("enabled_user_skills") {
                        Some(Value::Null) | None => Vec::new(),
                        Some(value) => serde_json::from_value::<Vec<String>>(value.clone())
                            .map_err(|error| {
                                OpenBitFunError::config(format!(
                                    "Invalid enabled_user_skills for mode '{}': {}",
                                    agent_id, error
                                ))
                            })?,
                    }
                } else {
                    current
                        .map(|item| item.enabled_user_skills.clone())
                        .unwrap_or_default()
                };

                let subagent_overrides = if config
                    .as_object()
                    .map(|obj| obj.contains_key("subagent_overrides"))
                    .unwrap_or(false)
                {
                    match config.get("subagent_overrides") {
                        Some(Value::Null) | None => ParentSubagentOverrideConfig::new(),
                        Some(value) => {
                            serde_json::from_value::<ParentSubagentOverrideConfig>(value.clone())
                                .map_err(|error| {
                                    OpenBitFunError::config(format!(
                                        "Invalid subagent_overrides for mode '{}': {}",
                                        agent_id, error
                                    ))
                                })?
                        }
                    }
                } else {
                    current
                        .map(|item| item.subagent_overrides.clone())
                        .unwrap_or_default()
                };

                let tool_permission_rules = if config
                    .as_object()
                    .map(|obj| obj.contains_key("tool_permission_rules"))
                    .unwrap_or(false)
                {
                    match config.get("tool_permission_rules") {
                        Some(Value::Null) | None => Vec::new(),
                        Some(value) => serde_json::from_value::<Vec<PermissionRule>>(value.clone())
                            .map_err(|error| {
                                OpenBitFunError::config(format!(
                                    "Invalid tool_permission_rules for mode '{}': {}",
                                    agent_id, error
                                ))
                            })?,
                    }
                } else {
                    current
                        .map(|item| item.tool_permission_rules.clone())
                        .unwrap_or_default()
                };

                let extensions = current
                    .map(|config| config.extensions.clone())
                    .unwrap_or_default();
                let canonical = stored_agent_profile_from_tool_selection(
                    agent_id,
                    enabled_tools,
                    disabled_user_skills,
                    enabled_user_skills,
                    subagent_overrides,
                    tool_permission_rules,
                    default_tools,
                    &valid_tools,
                );
                if let Some(canonical) =
                    retain_profile_extensions(&profile_id, canonical, extensions)
                {
                    stored_configs.insert(profile_id, canonical);
                } else {
                    stored_configs.remove(&profile_id);
                }

                Ok(())
            },
        )
        .await
}

pub async fn reset_agent_profile_to_default(agent_id: &str) -> OpenBitFunResult<()> {
    let config_service = GlobalConfigManager::get_service().await?;
    let profile_id = resolve_profile_id(agent_id);

    config_service
        .update_config(
            "ai.agent_profiles",
            |stored_configs: &mut HashMap<String, AgentProfileConfig>| {
                if let Some(current) = stored_configs.get_mut(&profile_id) {
                    current.added_tools.clear();
                    current.removed_tools.clear();

                    if current.disabled_user_skills.is_empty()
                        && current.enabled_user_skills.is_empty()
                        && current.subagent_overrides.is_empty()
                        && current.tool_permission_rules.is_empty()
                        && current.extensions.is_empty()
                    {
                        stored_configs.remove(&profile_id);
                    }
                }

                Ok(())
            },
        )
        .await
}

/// Canonicalizes stored mode profile overrides.
pub async fn canonicalize_agent_profile_configs(
) -> OpenBitFunResult<AgentProfileConfigCanonicalizationReport> {
    let config_service = GlobalConfigManager::get_service().await?;
    let valid_tools = get_valid_tool_names().await;
    let profile_defaults = get_profile_defaults().await;
    config_service
        .update_config(
            "ai.agent_profiles",
            |raw_agent_profiles: &mut Map<String, Value>| {
                let migrated = openbitfun_config_contracts::agent_identity_migration::canonicalize_agent_profile_keys(raw_agent_profiles)
                    .map_err(OpenBitFunError::config)?;
                let mut rewritten_agent_profiles = Map::new();
                let mut updated_profiles = Vec::new();
                let mut removed_profile_configs = Vec::new();

                for (profile_id, default_tools) in &profile_defaults {
                    let raw_profile = migrated.get(profile_id);
                    let canonical = canonicalize_agent_profile(
                        profile_id,
                        raw_profile,
                        default_tools,
                        &valid_tools,
                    )?;
                    if let Some(config) = canonical {
                        if raw_profile.is_some() {
                            updated_profiles.push(AgentProfileConfigUpdateInfo {
                                profile_id: profile_id.clone(),
                                added_tools: config.added_tools.clone(),
                                removed_tools: config.removed_tools.clone(),
                            });
                        }
                        rewritten_agent_profiles
                            .insert(profile_id.clone(), serde_json::to_value(config)?);
                    } else if raw_profile.is_some() {
                        removed_profile_configs.push(profile_id.clone());
                    }
                }

                // Profiles we cannot resolve defaults for are kept, not dropped. Canonicalization
                // runs at startup with no workspace, so project-scoped sub-agents are invisible
                // here; pruning them would silently discard the user's stored selection every
                // launch. Unknown or unreadable records must survive an upgrade unchanged.
                for (profile_id, raw_profile) in migrated.iter() {
                    if profile_defaults.contains_key(profile_id) {
                        continue;
                    }
                    rewritten_agent_profiles.insert(profile_id.clone(), raw_profile.clone());
                }

                *raw_agent_profiles = rewritten_agent_profiles;

                Ok(AgentProfileConfigCanonicalizationReport {
                    removed_profile_configs,
                    updated_profiles,
                })
            },
        )
        .await
}

pub fn agent_profile_member_mode_ids_for(agent_id: &str) -> Vec<String> {
    let profile_id = resolve_profile_id(agent_id);
    let members = mode_config_profile_member_mode_ids(&profile_id);
    if members.is_empty() {
        vec![agent_id.to_string()]
    } else {
        members
            .iter()
            .map(|mode_id| (*mode_id).to_string())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::{
        agent_profile_member_mode_ids_for, canonicalize_agent_profile, get_agent_defaults,
        normalize_skill_override_lists, stored_agent_profile_from_overrides,
        StoredAgentProfileOverrides,
    };
    use crate::agentic::agents::get_agent_registry;
    use crate::service::config::types::AgentSubagentOverrideState;
    use openbitfun_runtime_ports::{PermissionEffect, PermissionRule};
    use serde_json::Value;
    use std::collections::HashSet;

    #[test]
    fn page_manage_default_preserves_legacy_tool_overrides_and_round_trip() {
        let defaults = vec!["PageManage".into()];
        let valid = HashSet::from([
            "PageManage".into(),
            "PagePublish".into(),
            "PageDeploy".into(),
        ]);
        assert_eq!(
            super::resolve_effective_tools(&defaults, None, &valid),
            defaults
        );
        for legacy in ["PagePublish", "PageDeploy"] {
            let raw = serde_json::json!({"profile_id":"Standard", "removed_tools":[legacy]});
            let config = canonicalize_agent_profile("Standard", Some(&raw), &defaults, &valid)
                .unwrap()
                .unwrap();
            let retained = if legacy == "PagePublish" {
                "PageDeploy"
            } else {
                "PagePublish"
            };
            assert_eq!(
                super::resolve_effective_tools(&defaults, Some(&config), &valid),
                vec![retained]
            );
            let saved = serde_json::to_value(config).unwrap();
            assert_eq!(saved["removed_tools"], raw["removed_tools"]);
            let restored = serde_json::from_value(saved).unwrap();
            assert_eq!(
                super::resolve_effective_tools(&defaults, Some(&restored), &valid),
                vec![retained]
            );
            let raw = serde_json::json!({"profile_id":"Standard", "added_tools":[legacy]});
            let config = canonicalize_agent_profile("Standard", Some(&raw), &defaults, &valid)
                .unwrap()
                .unwrap();
            assert_eq!(
                super::resolve_effective_tools(&defaults, Some(&config), &valid),
                vec![legacy]
            );
        }
        let raw = serde_json::json!({"profile_id":"Standard", "removed_tools":["PagePublish", "PageDeploy"]});
        let config = canonicalize_agent_profile("Standard", Some(&raw), &defaults, &valid)
            .unwrap()
            .unwrap();
        assert!(super::resolve_effective_tools(&defaults, Some(&config), &valid).is_empty());
        let raw = serde_json::json!({"profile_id":"Standard", "removed_tools":["PagePublish"], "added_tools":["PageManage"]});
        let config = canonicalize_agent_profile("Standard", Some(&raw), &defaults, &valid)
            .unwrap()
            .unwrap();
        assert_eq!(
            super::resolve_effective_tools(&defaults, Some(&config), &valid),
            defaults
        );
        let raw = serde_json::json!({"profile_id":"Standard", "removed_tools":["PageManage", "PagePublish"]});
        let config = canonicalize_agent_profile("Standard", Some(&raw), &defaults, &valid)
            .unwrap()
            .unwrap();
        assert!(super::resolve_effective_tools(&defaults, Some(&config), &valid).is_empty());
    }

    #[test]
    fn canonicalization_retains_future_fields_even_without_known_overrides() {
        for raw in [
            serde_json::json!({"profile_id": "Standard", "future_policy": {"enabled": false}}),
            serde_json::json!({"profile_id": "Standard", "removed_tools": ["Bash"], "future_policy": ["x"]}),
        ] {
            let config = canonicalize_agent_profile(
                "Standard",
                Some(&raw),
                &["Bash".into()],
                &HashSet::from(["Bash".into()]),
            )
            .unwrap()
            .unwrap();
            let saved = serde_json::to_value(config).unwrap();
            assert_eq!(saved["future_policy"], raw["future_policy"]);
            assert_eq!(saved["removed_tools"], raw["removed_tools"]);
        }
    }

    /// Skill selection is stored per agent profile, so every agent whose default
    /// tools include `Skill` must resolve to a profile default. Otherwise saving
    /// its selection fails with "Agent does not exist" — which is what happened
    /// to `ComputerUse`, a sub-agent the agents scene renders as a core card.
    #[tokio::test]
    async fn agents_shipping_the_skill_tool_can_own_a_stored_profile() {
        let defaults = get_agent_defaults().await;

        assert!(
            defaults.contains_key("ComputerUse"),
            "ComputerUse ships the Skill tool but cannot own a stored profile"
        );

        for subagent in get_agent_registry().get_subagents_info(None).await {
            if subagent.default_tools.iter().any(|tool| tool == "Skill") {
                assert!(
                    defaults.contains_key(&subagent.id),
                    "sub-agent '{}' ships the Skill tool but cannot own a stored profile",
                    subagent.id
                );
            }
        }
    }

    #[test]
    fn normalize_skill_override_lists_removes_duplicates_and_conflicts() {
        let (disabled, enabled) = normalize_skill_override_lists(
            vec![
                "user::openbitfun-system::ppt-design".to_string(),
                "user::openbitfun-system::ppt-design".to_string(),
            ],
            vec![
                "user::openbitfun-system::ppt-design".to_string(),
                "user::openbitfun-system::agent-browser".to_string(),
                "user::openbitfun-system::agent-browser".to_string(),
            ],
        );

        assert_eq!(
            disabled,
            vec!["user::openbitfun-system::ppt-design".to_string()]
        );
        assert_eq!(
            enabled,
            vec!["user::openbitfun-system::agent-browser".to_string()]
        );
    }

    #[test]
    fn stored_agent_profile_from_overrides_keeps_enabled_user_skills() {
        let valid_tools = HashSet::new();
        let stored = stored_agent_profile_from_overrides(StoredAgentProfileOverrides {
            agent_id: "Standard",
            added_tools: Vec::new(),
            removed_tools: Vec::new(),
            disabled_user_skills: Vec::new(),
            enabled_user_skills: vec!["user::openbitfun-system::ppt-design".to_string()],
            subagent_overrides: Default::default(),
            tool_permission_rules: Vec::new(),
            default_tools: &[],
            valid_tools: &valid_tools,
        })
        .expect("mode config should be retained when skill overrides exist");

        assert_eq!(stored.profile_id, "Standard");
        assert_eq!(
            stored.enabled_user_skills,
            vec!["user::openbitfun-system::ppt-design".to_string()]
        );
        assert!(stored.disabled_user_skills.is_empty());
    }

    #[test]
    fn stored_agent_profile_from_overrides_keeps_subagent_overrides() {
        let valid_tools = HashSet::new();
        let mut subagent_overrides = std::collections::HashMap::new();
        subagent_overrides.insert(
            "builtin::builtin::Explore".to_string(),
            AgentSubagentOverrideState::Disabled,
        );
        let stored = stored_agent_profile_from_overrides(StoredAgentProfileOverrides {
            agent_id: "Standard",
            added_tools: Vec::new(),
            removed_tools: Vec::new(),
            disabled_user_skills: Vec::new(),
            enabled_user_skills: Vec::new(),
            subagent_overrides: subagent_overrides.clone(),
            tool_permission_rules: Vec::new(),
            default_tools: &[],
            valid_tools: &valid_tools,
        })
        .expect("mode config should be retained when subagent overrides exist");

        assert_eq!(stored.profile_id, "Standard");
        assert_eq!(stored.subagent_overrides, subagent_overrides);
    }

    #[test]
    fn stored_agent_profile_from_overrides_keeps_permission_rules() {
        let valid_tools = HashSet::new();
        let rules = vec![PermissionRule::new(
            "read",
            "secrets/*",
            PermissionEffect::Deny,
        )];
        let stored = stored_agent_profile_from_overrides(StoredAgentProfileOverrides {
            agent_id: "Standard",
            added_tools: Vec::new(),
            removed_tools: Vec::new(),
            disabled_user_skills: Vec::new(),
            enabled_user_skills: Vec::new(),
            subagent_overrides: Default::default(),
            tool_permission_rules: rules.clone(),
            default_tools: &[],
            valid_tools: &valid_tools,
        })
        .expect("permission-only profile should be retained");

        assert_eq!(stored.tool_permission_rules, rules);
    }

    #[test]
    fn canonicalize_agent_profile_preserves_permission_rules() {
        let raw = serde_json::json!({
            "tool_permission_rules": [{
                "action": "edit",
                "resource": "generated/*",
                "effect": "allow"
            }]
        });
        let canonical = canonicalize_agent_profile("Standard", Some(&raw), &[], &HashSet::new())
            .expect("profile should canonicalize")
            .expect("permission-only profile should be present");

        assert_eq!(canonical.tool_permission_rules.len(), 1);
        assert_eq!(canonical.tool_permission_rules[0].action, "edit");
    }

    #[test]
    fn canonicalize_agent_profile_treats_null_as_missing() {
        let canonical =
            canonicalize_agent_profile("Claw", Some(&Value::Null), &[], &HashSet::new())
                .expect("null mode config should be ignored");

        assert!(canonical.is_none());
    }

    #[test]
    fn canonicalize_agent_profile_preserves_mcp_override_before_registration() {
        let raw = serde_json::json!({
            "profile_id": "Standard",
            "added_tools": ["mcp__github__list_issues", "missing_static_tool"]
        });
        let canonical = canonicalize_agent_profile(
            "Standard",
            Some(&raw),
            &["Read".to_string()],
            &HashSet::from(["Read".to_string()]),
        )
        .expect("profile should canonicalize")
        .expect("the MCP override should keep the profile");

        assert_eq!(
            canonical.added_tools,
            vec!["mcp__github__list_issues".to_string()]
        );
    }

    #[test]
    fn canonicalize_agent_profile_preserves_explicit_canvas_selection() {
        let raw = serde_json::json!({
            "profile_id": "Standard",
            "added_tools": ["CreateCanvas"]
        });
        let canonical = canonicalize_agent_profile(
            "Standard",
            Some(&raw),
            &["Read".to_string()],
            &HashSet::from(["Read".to_string(), "CreateCanvas".to_string()]),
        )
        .expect("profile should canonicalize")
        .expect("the explicit Canvas selection should keep the profile");

        assert_eq!(canonical.added_tools, vec!["CreateCanvas".to_string()]);
        assert!(canonical.removed_tools.is_empty());
    }

    #[test]
    fn shared_modes_report_shared_profile_members() {
        assert_eq!(
            agent_profile_member_mode_ids_for("Standard"),
            vec!["Standard".to_string()]
        );
        assert_eq!(
            agent_profile_member_mode_ids_for("Cowork"),
            vec!["Cowork".to_string()]
        );
    }
}
