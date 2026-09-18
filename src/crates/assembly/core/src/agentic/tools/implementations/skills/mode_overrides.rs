//! Mode-profile specific skill override helpers.

use crate::agentic::agents::resolve_mode_config_profile_id;
use crate::agentic::workspace::WorkspaceFileSystem;
use crate::service::config::agent_profile_project_store::{
    deserialize_project_agent_profiles_document, get_disabled_project_skills,
    load_project_agent_profiles_document_local, project_agent_profiles_path_for_remote,
    save_project_agent_profiles_document_local, set_disabled_project_skills,
    set_project_skill_disabled, ProjectAgentProfilesDocument,
};
use crate::service::config::global::GlobalConfigManager;
use crate::service::config::mode_config_canonicalizer::persist_agent_profile_from_value;
use crate::service::config::types::{AgentProfileConfig, SkillSettingsConfig};
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
pub use openbitfun_agent_runtime::skills::UserModeSkillOverrides;
use openbitfun_agent_runtime::skills::{normalize_skill_keys, normalize_user_mode_skill_overrides};
use serde_json::json;
use std::collections::HashMap;
use std::path::Path;

fn resolve_profile_id(mode_id: &str) -> String {
    resolve_mode_config_profile_id(mode_id).into_owned()
}

pub async fn load_user_mode_skill_overrides(
    mode_id: &str,
) -> OpenBitFunResult<UserModeSkillOverrides> {
    let config_service = GlobalConfigManager::get_service().await?;
    let stored_configs: HashMap<String, AgentProfileConfig> = config_service
        .get_config(Some("ai.agent_profiles"))
        .await
        .unwrap_or_default();
    let profile_id = resolve_profile_id(mode_id);

    let config = stored_configs.get(&profile_id);
    Ok(normalize_user_mode_skill_overrides(
        config
            .map(|item| item.disabled_user_skills.clone())
            .unwrap_or_default(),
        config
            .map(|item| item.enabled_user_skills.clone())
            .unwrap_or_default(),
    ))
}

pub async fn set_user_mode_skill_state(
    mode_id: &str,
    skill_key: &str,
    enabled: bool,
    default_enabled: bool,
) -> OpenBitFunResult<UserModeSkillOverrides> {
    let mut overrides = load_user_mode_skill_overrides(mode_id).await?;
    overrides.disabled_skills.retain(|value| value != skill_key);
    overrides.enabled_skills.retain(|value| value != skill_key);

    if default_enabled {
        if !enabled {
            overrides.disabled_skills.push(skill_key.to_string());
        }
    } else if enabled {
        overrides.enabled_skills.push(skill_key.to_string());
    }

    let overrides =
        normalize_user_mode_skill_overrides(overrides.disabled_skills, overrides.enabled_skills);

    persist_agent_profile_from_value(
        mode_id,
        json!({
            "disabled_user_skills": overrides.disabled_skills,
            "enabled_user_skills": overrides.enabled_skills,
        }),
    )
    .await?;

    load_user_mode_skill_overrides(mode_id).await
}

pub async fn clear_user_mode_skill_overrides(
    mode_id: &str,
) -> OpenBitFunResult<UserModeSkillOverrides> {
    persist_agent_profile_from_value(
        mode_id,
        json!({
            "disabled_user_skills": Vec::<String>::new(),
            "enabled_user_skills": Vec::<String>::new(),
        }),
    )
    .await?;

    load_user_mode_skill_overrides(mode_id).await
}

pub async fn load_globally_disabled_user_skills() -> OpenBitFunResult<Vec<String>> {
    let config_service = GlobalConfigManager::get_service().await?;
    let settings: SkillSettingsConfig = config_service
        .get_config(Some("ai.skill_settings"))
        .await
        .unwrap_or_default();
    Ok(normalize_skill_keys(settings.globally_disabled_user_skills))
}

pub async fn set_global_user_skill_disabled(
    skill_key: &str,
    disabled: bool,
) -> OpenBitFunResult<Vec<String>> {
    let skill_key = skill_key.trim();
    if skill_key.is_empty() {
        return Ok(Vec::new());
    }

    let config_service = GlobalConfigManager::get_service().await?;
    config_service
        .update_config("ai.skill_settings", |settings: &mut SkillSettingsConfig| {
            if disabled {
                settings
                    .globally_disabled_user_skills
                    .push(skill_key.to_string());
            } else {
                settings
                    .globally_disabled_user_skills
                    .retain(|key| key != skill_key);
            }
            settings.globally_disabled_user_skills =
                normalize_skill_keys(std::mem::take(&mut settings.globally_disabled_user_skills));

            Ok(settings.globally_disabled_user_skills.clone())
        })
        .await
}

/// The workspace whose project-level Skill availability policy is being read
/// or written. The record ID owns the policy; the root only names the folder
/// whose retired canonical-path entry may still need a one-time upgrade.
#[derive(Debug, Clone, Copy)]
pub struct SkillPolicyWorkspace<'a> {
    pub workspace_id: &'a str,
    pub root: &'a Path,
}

impl<'a> SkillPolicyWorkspace<'a> {
    pub fn from_record(record: &'a crate::service::workspace::WorkspaceInfo) -> Self {
        Self {
            workspace_id: record.id.as_str(),
            root: record.root_path.as_path(),
        }
    }

    /// A session binding names its workspace by ID; a binding written before
    /// workspace IDs has no project policy scope until it is upgraded.
    pub fn from_binding(binding: &'a crate::agentic::workspace::WorkspaceBinding) -> Option<Self> {
        let workspace_id = binding
            .workspace_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())?;
        Some(Self {
            workspace_id,
            root: binding.root_path(),
        })
    }
}

/// Settings key that owns a workspace's project-level Skill availability.
fn skill_workspace_identity(workspace_id: &str) -> String {
    format!("workspace:{}", workspace_id.trim())
}

/// Retired canonical-path key written by builds that predate workspace IDs.
fn legacy_skill_workspace_identity(root: &Path) -> Option<String> {
    dunce::canonicalize(root)
        .ok()
        .map(|path| path.to_string_lossy().into_owned())
}

/// Copy a retired canonical-path entry to the workspace ID key once. The old
/// entry is kept for rollback and an existing ID entry is never overwritten.
fn upgrade_legacy_project_skill_availability(
    settings: &mut SkillSettingsConfig,
    legacy_identity: Option<&str>,
    identity: &str,
) -> bool {
    if settings
        .globally_disabled_project_skills
        .contains_key(identity)
    {
        return false;
    }
    let Some(keys) = legacy_identity
        .and_then(|legacy| settings.globally_disabled_project_skills.get(legacy))
        .cloned()
    else {
        return false;
    };
    settings
        .globally_disabled_project_skills
        .insert(identity.to_string(), keys);
    true
}

pub async fn load_globally_disabled_project_skills(
    workspace: SkillPolicyWorkspace<'_>,
) -> OpenBitFunResult<Vec<String>> {
    let identity = skill_workspace_identity(workspace.workspace_id);
    let config_service = GlobalConfigManager::get_service().await?;
    let settings: SkillSettingsConfig =
        config_service.get_config(Some("ai.skill_settings")).await?;
    if let Some(keys) = settings.globally_disabled_project_skills.get(&identity) {
        return Ok(keys.clone());
    }
    let legacy_identity = legacy_skill_workspace_identity(workspace.root);
    if legacy_identity.as_deref().is_none_or(|legacy| {
        !settings
            .globally_disabled_project_skills
            .contains_key(legacy)
    }) {
        return Ok(Vec::new());
    }
    config_service
        .update_config("ai.skill_settings", |settings: &mut SkillSettingsConfig| {
            upgrade_legacy_project_skill_availability(
                settings,
                legacy_identity.as_deref(),
                &identity,
            );
            Ok(settings
                .globally_disabled_project_skills
                .get(&identity)
                .cloned()
                .unwrap_or_default())
        })
        .await
}

pub async fn set_global_project_skill_disabled(
    workspace: SkillPolicyWorkspace<'_>,
    skill_key: &str,
    disabled: bool,
) -> OpenBitFunResult<Vec<String>> {
    let identity = skill_workspace_identity(workspace.workspace_id);
    let legacy_identity = legacy_skill_workspace_identity(workspace.root);
    let config_service = GlobalConfigManager::get_service().await?;
    config_service
        .update_config("ai.skill_settings", |settings: &mut SkillSettingsConfig| {
            upgrade_legacy_project_skill_availability(
                settings,
                legacy_identity.as_deref(),
                &identity,
            );
            let keys = update_project_skill_availability(settings, &identity, skill_key, disabled);
            if keys.is_empty() {
                // Re-enabling the last project Skill applies to the retired
                // entry too; otherwise the next load would upgrade it again.
                if let Some(legacy) = legacy_identity.as_deref() {
                    settings.globally_disabled_project_skills.remove(legacy);
                }
            }
            Ok(keys)
        })
        .await
}

fn update_project_skill_availability(
    settings: &mut SkillSettingsConfig,
    identity: &str,
    skill_key: &str,
    disabled: bool,
) -> Vec<String> {
    let keys = settings
        .globally_disabled_project_skills
        .entry(identity.to_string())
        .or_default();
    keys.retain(|key| key != skill_key);
    if disabled {
        keys.push(skill_key.to_string());
    }
    *keys = normalize_skill_keys(std::mem::take(keys));
    let result = keys.clone();
    if result.is_empty() {
        settings.globally_disabled_project_skills.remove(identity);
    }
    result
}

#[cfg(test)]
mod availability_tests {
    use super::*;

    #[test]
    fn project_policy_is_keyed_by_workspace_id_and_isolates_user_policy() {
        let first_id = skill_workspace_identity("workspace-first");
        let padded = skill_workspace_identity(" workspace-first ");
        assert_eq!(first_id, padded);
        let second_id = skill_workspace_identity("workspace-second");
        let key = "project::agents::review";
        let mut settings = SkillSettingsConfig::default();
        settings
            .globally_disabled_user_skills
            .push("user::home.agents::review".into());
        update_project_skill_availability(&mut settings, &first_id, key, true);
        update_project_skill_availability(&mut settings, &padded, key, true);
        assert_eq!(settings.globally_disabled_project_skills[&first_id], [key]);
        assert!(!settings
            .globally_disabled_project_skills
            .contains_key(&second_id));
        update_project_skill_availability(&mut settings, &second_id, key, true);
        let mut restored: SkillSettingsConfig =
            serde_json::from_value(serde_json::to_value(settings).unwrap()).unwrap();
        update_project_skill_availability(&mut restored, &padded, key, false);
        assert!(!restored
            .globally_disabled_project_skills
            .contains_key(&first_id));
        assert_eq!(restored.globally_disabled_project_skills[&second_id], [key]);
        assert_eq!(
            restored.globally_disabled_user_skills,
            ["user::home.agents::review"]
        );
    }

    #[test]
    fn legacy_canonical_path_policy_upgrades_once_to_the_workspace_id_key() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        std::fs::create_dir(&root).unwrap();
        let legacy = legacy_skill_workspace_identity(&root).unwrap();
        assert_eq!(
            legacy,
            legacy_skill_workspace_identity(&root.join(".")).unwrap()
        );
        let identity = skill_workspace_identity("workspace-1");
        let key = "project::agents::review";

        // Settings written by a pre-ID build carry only the canonical-path key.
        let mut settings = SkillSettingsConfig::default();
        settings
            .globally_disabled_project_skills
            .insert(legacy.clone(), vec![key.to_string()]);
        let mut settings: SkillSettingsConfig =
            serde_json::from_value(serde_json::to_value(&settings).unwrap()).unwrap();
        assert!(upgrade_legacy_project_skill_availability(
            &mut settings,
            Some(&legacy),
            &identity
        ));
        assert_eq!(settings.globally_disabled_project_skills[&identity], [key]);
        // The retired entry stays for rollback.
        assert_eq!(settings.globally_disabled_project_skills[&legacy], [key]);

        // An existing ID entry is never overwritten by the retired one.
        update_project_skill_availability(&mut settings, &identity, "project::other", true);
        assert!(!upgrade_legacy_project_skill_availability(
            &mut settings,
            Some(&legacy),
            &identity
        ));
        assert_eq!(
            settings.globally_disabled_project_skills[&identity],
            [key, "project::other"]
        );
        // Without a legacy entry there is nothing to upgrade.
        let mut fresh = SkillSettingsConfig::default();
        assert!(!upgrade_legacy_project_skill_availability(
            &mut fresh,
            Some("/nowhere"),
            &identity
        ));
        assert!(!upgrade_legacy_project_skill_availability(
            &mut fresh, None, &identity
        ));
    }
}

pub fn project_mode_skills_path_for_remote(remote_root: &str) -> String {
    project_agent_profiles_path_for_remote(remote_root)
}

pub fn get_disabled_mode_skills_from_document(
    document: &ProjectAgentProfilesDocument,
    mode_id: &str,
) -> Vec<String> {
    get_disabled_project_skills(document, &resolve_profile_id(mode_id))
}

pub fn set_mode_skill_disabled_in_document(
    document: &mut ProjectAgentProfilesDocument,
    mode_id: &str,
    skill_key: &str,
    disabled: bool,
) -> OpenBitFunResult<Vec<String>> {
    Ok(set_project_skill_disabled(
        document,
        &resolve_profile_id(mode_id),
        skill_key,
        disabled,
    ))
}

pub fn set_disabled_mode_skills_in_document(
    document: &mut ProjectAgentProfilesDocument,
    mode_id: &str,
    skill_keys: Vec<String>,
) -> OpenBitFunResult<Vec<String>> {
    Ok(set_disabled_project_skills(
        document,
        &resolve_profile_id(mode_id),
        skill_keys,
    ))
}

pub async fn load_project_mode_skills_document_local(
    workspace_root: &Path,
) -> OpenBitFunResult<ProjectAgentProfilesDocument> {
    load_project_agent_profiles_document_local(workspace_root).await
}

pub async fn save_project_mode_skills_document_local(
    workspace_root: &Path,
    document: &ProjectAgentProfilesDocument,
) -> OpenBitFunResult<()> {
    save_project_agent_profiles_document_local(workspace_root, document).await
}

pub async fn load_disabled_mode_skills_local(
    workspace_root: &Path,
    mode_id: &str,
) -> OpenBitFunResult<Vec<String>> {
    let document = load_project_agent_profiles_document_local(workspace_root).await?;
    Ok(get_disabled_project_skills(
        &document,
        &resolve_profile_id(mode_id),
    ))
}

pub async fn load_disabled_mode_skills_remote(
    fs: &dyn WorkspaceFileSystem,
    remote_root: &str,
    mode_id: &str,
) -> OpenBitFunResult<Vec<String>> {
    let path = project_agent_profiles_path_for_remote(remote_root);
    let exists = fs.exists(&path).await.unwrap_or(false);
    if !exists {
        return Ok(Vec::new());
    }

    let content = fs.read_file_text(&path).await.map_err(|error| {
        OpenBitFunError::config(format!(
            "Failed to read remote project mode profiles: {}",
            error
        ))
    })?;
    let document = deserialize_project_agent_profiles_document(&content)?;
    Ok(get_disabled_project_skills(
        &document,
        &resolve_profile_id(mode_id),
    ))
}
