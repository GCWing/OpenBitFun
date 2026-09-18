//! Skill Management API

use log::info;
use openbitfun_core::service::workspace::{WorkspaceInfo, WorkspaceKind};
use regex::Regex;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;
use tauri::State;
use tokio::sync::RwLock;
use tokio::task::JoinSet;
use tokio::time::{timeout, Duration};

use crate::api::app_state::AppState;
use openbitfun_core::agentic::tools::implementations::skills::mode_overrides::{
    clear_user_mode_skill_overrides, load_globally_disabled_project_skills,
    load_globally_disabled_user_skills, load_project_mode_skills_document_local,
    project_mode_skills_path_for_remote, save_project_mode_skills_document_local,
    set_disabled_mode_skills_in_document, set_global_project_skill_disabled,
    set_global_user_skill_disabled, set_mode_skill_disabled_in_document, set_user_mode_skill_state,
    SkillPolicyWorkspace,
};
use openbitfun_core::agentic::tools::implementations::skills::registry::imports::{
    self as skill_imports, SkillImportPreview,
};
use openbitfun_core::agentic::tools::implementations::skills::{
    resolver::resolve_skill_default_enabled_for_mode, ModeSkillInfo, SkillData, SkillInfo,
    SkillLocation, SkillRegistry, SkillScanReport,
};
use openbitfun_core::agentic::workspace::RemoteWorkspaceFs;
use openbitfun_core::infrastructure::get_path_manager_arc;
use openbitfun_core::service::config::agent_profile_project_store::{
    deserialize_project_agent_profiles_document, serialize_project_agent_profiles_document,
};
use openbitfun_core::service::runtime::RuntimeManager;
use openbitfun_core::util::process_manager;

const SKILLS_SEARCH_API_BASE: &str = "https://skills.sh";
const DEFAULT_MARKET_QUERY: &str = "skill";
const DEFAULT_MARKET_LIMIT: u32 = 12;
const MAX_MARKET_LIMIT: u32 = 500;
const MAX_OUTPUT_PREVIEW_CHARS: usize = 2000;
const MARKET_DESC_FETCH_TIMEOUT_SECS: u64 = 4;
const MARKET_DESC_FETCH_CONCURRENCY: usize = 6;
const MARKET_DESC_MAX_LEN: usize = 220;
const REMOTE_SKILL_DISCOVERY_TIMEOUT: Duration = Duration::from_secs(60);

static MARKET_DESCRIPTION_CACHE: OnceLock<RwLock<HashMap<String, String>>> = OnceLock::new();

async fn await_remote_skill_discovery<T>(
    operation: impl std::future::Future<Output = Result<T, String>>,
    deadline: Duration,
) -> Result<T, String> {
    timeout(deadline, operation)
        .await
        .map_err(|_| {
            format!(
                "Remote Skill discovery timed out after {} seconds. Check the SSH/SFTP connection and retry.",
                deadline.as_secs().max(1)
            )
        })?
}

fn can_delete_owned_skill(source_id: &str, source_slot: &str, is_builtin: bool) -> bool {
    if is_builtin {
        return false;
    }

    let source_id = source_id.trim().to_ascii_lowercase();
    if !source_id.is_empty() {
        return matches!(source_id.as_str(), "openbitfun" | "openbitfun-system");
    }

    let source_slot = source_slot.trim().to_ascii_lowercase();
    source_slot.starts_with("openbitfun")
}

fn ensure_skill_can_be_deleted(skill: &SkillInfo) -> Result<(), String> {
    if can_delete_owned_skill(&skill.source_id, &skill.source_slot, skill.is_builtin) {
        Ok(())
    } else {
        Err("Only OpenBitFun-owned, non-built-in Skills can be deleted from OpenBitFun".to_string())
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SkillValidationResult {
    #[serde(
        default,
        rename = "importPreview",
        skip_serializing_if = "Option::is_none"
    )]
    pub import_preview: Option<SkillImportPreview>,
    pub valid: bool,
    pub name: Option<String>,
    pub description: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillMarketListRequest {
    pub query: Option<String>,
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillMarketSearchRequest {
    pub query: String,
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillMarketDownloadRequest {
    #[serde(default)]
    pub workspace_id: Option<String>,
    pub package: String,
    pub level: Option<SkillLocation>,
    pub workspace_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillMarketDownloadResponse {
    pub package: String,
    pub level: SkillLocation,
    pub installed_skills: Vec<String>,
    pub output: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceModeSkillSelectionRequest {
    #[serde(default)]
    pub workspace_id: Option<String>,
    pub mode_id: String,
    pub enabled_skill_keys: Vec<String>,
    pub workspace_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetModeSkillSelectionRequest {
    #[serde(default)]
    pub workspace_id: Option<String>,
    pub mode_id: String,
    pub workspace_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetGlobalSkillDisabledRequest {
    #[serde(default)]
    pub workspace_id: Option<String>,
    pub skill_key: String,
    pub disabled: bool,
    #[serde(default)]
    pub workspace_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalSkillSettingsResponse {
    pub globally_disabled_user_skill_keys: Vec<String>,
    pub globally_disabled_project_skill_keys: Vec<String>,
    pub direct_skill_management_version: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetGlobalSkillSettingsRequest {
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillMarketItem {
    pub id: String,
    pub name: String,
    pub description: String,
    pub source: String,
    pub installs: u64,
    pub url: String,
    pub install_id: String,
}

#[derive(Debug, Clone, Deserialize)]
struct SkillSearchApiResponse {
    #[serde(default)]
    skills: Vec<SkillSearchApiItem>,
}

#[derive(Debug, Clone, Deserialize)]
struct SkillSearchApiItem {
    id: String,
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    source: String,
    #[serde(default)]
    installs: u64,
}

fn workspace_root_from_input(workspace: Option<&WorkspaceInfo>) -> Option<PathBuf> {
    workspace.map(|record| record.root_path.clone())
}

async fn resolve_remote_workspace(
    workspace: Option<&WorkspaceInfo>,
) -> Result<Option<(String, String)>, String> {
    let Some(record) = workspace else {
        return Ok(None);
    };
    Ok(record.filesystem_connection_id()?.map(|connection| {
        (
            record.root_path.to_string_lossy().into_owned(),
            connection.to_owned(),
        )
    }))
}

async fn get_all_skills_for_workspace_input(
    state: &State<'_, AppState>,
    registry: &SkillRegistry,
    workspace: Option<&WorkspaceInfo>,
) -> Result<Vec<SkillInfo>, String> {
    Ok(
        get_skill_scan_report_for_workspace_input(state, registry, workspace)
            .await?
            .skills,
    )
}

async fn get_skill_scan_report_for_workspace_input(
    state: &State<'_, AppState>,
    registry: &SkillRegistry,
    workspace: Option<&WorkspaceInfo>,
) -> Result<SkillScanReport, String> {
    if let Some((remote_root, entry)) = resolve_remote_workspace(workspace).await? {
        await_remote_skill_discovery(
            async {
                let remote_fs = state
                    .get_remote_file_service_async()
                    .await
                    .map_err(|e| format!("Remote file service not available: {}", e))?;
                let remote_workspace_fs = RemoteWorkspaceFs::new(entry, remote_fs);
                Ok(registry
                    .get_skill_scan_report_for_remote_workspace(&remote_workspace_fs, &remote_root)
                    .await)
            },
            REMOTE_SKILL_DISCOVERY_TIMEOUT,
        )
        .await
    } else {
        Ok(registry
            .get_skill_scan_report_for_workspace(workspace_root_from_input(workspace).as_deref())
            .await)
    }
}

async fn get_mode_skill_scan_report_for_workspace_input(
    state: &State<'_, AppState>,
    registry: &SkillRegistry,
    mode_id: &str,
    workspace: Option<&WorkspaceInfo>,
) -> Result<SkillScanReport<ModeSkillInfo>, String> {
    if let Some((remote_root, entry)) = resolve_remote_workspace(workspace).await? {
        await_remote_skill_discovery(
            async {
                let remote_fs = state
                    .get_remote_file_service_async()
                    .await
                    .map_err(|e| format!("Remote file service not available: {}", e))?;
                let remote_workspace_fs = RemoteWorkspaceFs::new(entry.clone(), remote_fs.clone());
                Ok(registry
                    .get_mode_skill_scan_report_for_remote_workspace(
                        &remote_workspace_fs,
                        &remote_root,
                        mode_id,
                    )
                    .await)
            },
            REMOTE_SKILL_DISCOVERY_TIMEOUT,
        )
        .await
    } else if let Some(record) = workspace {
        Ok(registry
            .get_mode_skill_scan_report_for_workspace(
                Some(SkillPolicyWorkspace::from_record(record)),
                mode_id,
            )
            .await)
    } else {
        // Mode-scoped built-in and user-level skills should still be available even
        // when no project workspace is open. In that case there are simply no
        // project-level overrides to apply.
        Ok(registry
            .get_mode_skill_scan_report_for_workspace(None, mode_id)
            .await)
    }
}

fn serialize_skill_scan_response<T: Serialize>(
    report: SkillScanReport<T>,
    include_diagnostics: bool,
) -> Result<Value, serde_json::Error> {
    if include_diagnostics {
        serde_json::to_value(report)
    } else {
        serde_json::to_value(report.skills)
    }
}

fn normalize_skill_key_list(keys: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();

    for key in keys {
        let trimmed = key.trim();
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

async fn persist_user_mode_skill_selection(
    mode_id: &str,
    all_skills: &[SkillInfo],
    enabled_keys: &HashSet<String>,
) -> Result<(), String> {
    let mut disabled_user_skills = Vec::new();
    let mut enabled_user_skills = Vec::new();

    for skill in all_skills
        .iter()
        .filter(|skill| skill.level == SkillLocation::User)
    {
        let should_enable = enabled_keys.contains(&skill.key);
        let default_enabled = resolve_skill_default_enabled_for_mode(skill, mode_id);

        if default_enabled && !should_enable {
            disabled_user_skills.push(skill.key.clone());
        } else if !default_enabled && should_enable {
            enabled_user_skills.push(skill.key.clone());
        }
    }

    openbitfun_core::service::config::mode_config_canonicalizer::persist_agent_profile_from_value(
        mode_id,
        serde_json::json!({
            "disabled_user_skills": normalize_skill_key_list(disabled_user_skills),
            "enabled_user_skills": normalize_skill_key_list(enabled_user_skills),
        }),
    )
    .await
    .map_err(|e| format!("Failed to update user skill overrides: {}", e))
}

fn build_disabled_project_skill_keys(
    all_skills: &[SkillInfo],
    enabled_keys: &HashSet<String>,
) -> Vec<String> {
    all_skills
        .iter()
        .filter(|skill| skill.level == SkillLocation::Project)
        .filter(|skill| !enabled_keys.contains(&skill.key))
        .map(|skill| skill.key.clone())
        .collect()
}

async fn persist_project_mode_skill_selection_local(
    mode_id: &str,
    workspace_root: &Path,
    disabled_project_skills: Vec<String>,
) -> Result<(), String> {
    let mut document = load_project_mode_skills_document_local(workspace_root)
        .await
        .map_err(|e| format!("Failed to load project mode skills: {}", e))?;
    set_disabled_mode_skills_in_document(&mut document, mode_id, disabled_project_skills)
        .map_err(|e| format!("Failed to update project skill overrides: {}", e))?;
    save_project_mode_skills_document_local(workspace_root, &document)
        .await
        .map_err(|e| format!("Failed to save project mode skills: {}", e))
}

async fn persist_project_mode_skill_selection_remote(
    state: &State<'_, AppState>,
    remote_root: &str,
    entry: &str,
    mode_id: &str,
    disabled_project_skills: Vec<String>,
) -> Result<(), String> {
    let remote_fs = state
        .get_remote_file_service_async()
        .await
        .map_err(|e| format!("Remote file service not available: {}", e))?;
    let config_path = project_mode_skills_path_for_remote(remote_root);
    let mut document = if remote_fs
        .exists(&entry, &config_path)
        .await
        .map_err(|e| format!("Failed to check remote project skill overrides: {}", e))?
    {
        let content = remote_fs
            .read_file(&entry, &config_path)
            .await
            .map_err(|e| format!("Failed to read remote project skill overrides: {}", e))?;
        let content = String::from_utf8(content)
            .map_err(|e| format!("Remote project skill overrides are not valid UTF-8: {}", e))?;
        deserialize_project_agent_profiles_document(&content)
            .map_err(|e| format!("Invalid remote project skill overrides JSON: {}", e))?
    } else {
        Default::default()
    };

    set_disabled_mode_skills_in_document(&mut document, mode_id, disabled_project_skills)
        .map_err(|e| format!("Failed to update remote project skill overrides: {}", e))?;

    let config_dir = config_path
        .rsplit_once('/')
        .map(|(dir, _)| dir.to_string())
        .ok_or_else(|| format!("Invalid remote project config path '{}'", config_path))?;

    remote_fs
        .create_dir_all(&entry, &config_dir)
        .await
        .map_err(|e| {
            format!(
                "Failed to create remote project skill overrides directory: {}",
                e
            )
        })?;
    remote_fs
        .write_file(
            &entry,
            &config_path,
            serialize_project_agent_profiles_document(&document)
                .map_err(|e| format!("Failed to serialize remote project skill overrides: {}", e))?
                .as_slice(),
        )
        .await
        .map_err(|e| format!("Failed to write remote project skill overrides: {}", e))?;

    Ok(())
}

async fn clear_project_mode_skill_selection_local(
    mode_id: &str,
    workspace_root: &Path,
) -> Result<(), String> {
    let path = get_path_manager_arc().project_agent_profiles_file(workspace_root);
    let exists = tokio::fs::try_exists(&path)
        .await
        .map_err(|e| format!("Failed to check project mode skills file: {}", e))?;
    if !exists {
        return Ok(());
    }

    let mut document = load_project_mode_skills_document_local(workspace_root)
        .await
        .map_err(|e| format!("Failed to load project mode skills: {}", e))?;
    set_disabled_mode_skills_in_document(&mut document, mode_id, Vec::new())
        .map_err(|e| format!("Failed to clear project skill overrides: {}", e))?;

    let document_is_empty = document.is_empty();

    if document_is_empty {
        match tokio::fs::remove_file(&path).await {
            Ok(_) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!(
                "Failed to remove project mode skills file: {}",
                error
            )),
        }
    } else {
        save_project_mode_skills_document_local(workspace_root, &document)
            .await
            .map_err(|e| format!("Failed to save project mode skills: {}", e))
    }
}

async fn clear_project_mode_skill_selection_remote(
    state: &State<'_, AppState>,
    remote_root: &str,
    entry: &str,
    mode_id: &str,
) -> Result<(), String> {
    let remote_fs = state
        .get_remote_file_service_async()
        .await
        .map_err(|e| format!("Remote file service not available: {}", e))?;
    let config_path = project_mode_skills_path_for_remote(remote_root);
    let exists = remote_fs
        .exists(&entry, &config_path)
        .await
        .map_err(|e| format!("Failed to check remote project skill overrides: {}", e))?;
    if !exists {
        return Ok(());
    }

    let content = remote_fs
        .read_file(&entry, &config_path)
        .await
        .map_err(|e| format!("Failed to read remote project skill overrides: {}", e))?;
    let content = String::from_utf8(content)
        .map_err(|e| format!("Remote project skill overrides are not valid UTF-8: {}", e))?;
    let mut document = deserialize_project_agent_profiles_document(&content)
        .map_err(|e| format!("Invalid remote project skill overrides JSON: {}", e))?;

    set_disabled_mode_skills_in_document(&mut document, mode_id, Vec::new())
        .map_err(|e| format!("Failed to clear remote project skill overrides: {}", e))?;

    let document_is_empty = document.is_empty();

    if document_is_empty {
        remote_fs
            .remove_file(&entry, &config_path)
            .await
            .map_err(|e| format!("Failed to remove remote project skill overrides: {}", e))?;
    } else {
        remote_fs
            .write_file(
                &entry,
                &config_path,
                serialize_project_agent_profiles_document(&document)
                    .map_err(|e| {
                        format!("Failed to serialize remote project skill overrides: {}", e)
                    })?
                    .as_slice(),
            )
            .await
            .map_err(|e| format!("Failed to write remote project skill overrides: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
pub async fn get_skill_configs(
    state: State<'_, AppState>,
    force_refresh: Option<bool>,
    include_diagnostics: Option<bool>,
    workspace_id: Option<String>,
    workspace_path: Option<String>,
) -> Result<Value, String> {
    let workspace =
        resolve_skill_workspace(workspace_id.as_deref(), workspace_path.as_deref()).await?;
    let registry = SkillRegistry::global();

    if force_refresh.unwrap_or(false) {
        registry.refresh().await;
    }

    let all_skills =
        get_skill_scan_report_for_workspace_input(&state, registry, workspace.as_ref()).await?;

    let mut response =
        serialize_skill_scan_response(all_skills, include_diagnostics.unwrap_or(false))
            .map_err(|e| format!("Failed to serialize skill configs: {}", e))?;
    if let Some(object) = response.as_object_mut() {
        let supported = match workspace.as_ref() {
            Some(record) => record.workspace_kind != WorkspaceKind::Remote,
            None => true,
        };
        object.insert(
            "importOperationsVersion".into(),
            serde_json::json!(if supported { 3 } else { 0 }),
        );
    }
    Ok(response)
}

async fn resolve_skill_workspace(
    id: Option<&str>,
    legacy_path: Option<&str>,
) -> Result<Option<WorkspaceInfo>, String> {
    if id.is_none() && legacy_path.is_none() {
        return Ok(None);
    }
    let service = openbitfun_core::service::workspace::get_global_workspace_service()
        .ok_or("Workspace service is unavailable")?;
    if let Some(id) = id {
        return service
            .require_workspace(id)
            .await
            .map(Some)
            .map_err(|e| e.to_string());
    }
    // Temporary pre-ID request ingress. Normal callers select a catalog ID.
    service
        .resolve_legacy_workspace_reference(None, legacy_path.unwrap_or_default(), None, None)
        .await
        .map_err(|e| e.to_string())?
        .map(Some)
        .ok_or_else(|| "Legacy Skill workspace cannot be resolved".into())
}

async fn skill_availability_settings(
    workspace: Option<&WorkspaceInfo>,
) -> Result<GlobalSkillSettingsResponse, String> {
    let globally_disabled_user_skill_keys = load_globally_disabled_user_skills()
        .await
        .map_err(|error| error.to_string())?;
    let globally_disabled_project_skill_keys = match workspace {
        Some(record) => {
            if record.workspace_kind == WorkspaceKind::Remote {
                return Err(
                    "Direct Skill availability management is not supported for remote workspaces"
                        .into(),
                );
            }
            load_globally_disabled_project_skills(SkillPolicyWorkspace::from_record(record))
                .await
                .map_err(|error| error.to_string())?
        }
        None => Vec::new(),
    };
    Ok(GlobalSkillSettingsResponse {
        globally_disabled_user_skill_keys,
        globally_disabled_project_skill_keys,
        direct_skill_management_version: 1,
    })
}

#[tauri::command]
pub async fn get_global_skill_settings(
    request: Option<GetGlobalSkillSettingsRequest>,
) -> Result<GlobalSkillSettingsResponse, String> {
    let workspace = resolve_skill_workspace(
        request.as_ref().and_then(|r| r.workspace_id.as_deref()),
        request.as_ref().and_then(|r| r.workspace_path.as_deref()),
    )
    .await?;
    skill_availability_settings(workspace.as_ref()).await
}

#[tauri::command]
pub async fn set_global_skill_disabled(
    request: SetGlobalSkillDisabledRequest,
) -> Result<GlobalSkillSettingsResponse, String> {
    let skill_key = request.skill_key.trim();
    let workspace = resolve_skill_workspace(
        request.workspace_id.as_deref(),
        request.workspace_path.as_deref(),
    )
    .await?;
    // Validate the serving scope before scanning or persisting any local state.
    if let Some(record) = workspace.as_ref() {
        if record.workspace_kind == WorkspaceKind::Remote {
            return Err(
                "Direct Skill availability management is not supported for remote workspaces"
                    .into(),
            );
        }
    }
    let known_skill = SkillRegistry::global()
        .get_all_skills_for_workspace(workspace.as_ref().map(|record| record.root_path.as_path()))
        .await
        .into_iter()
        .find(|skill| skill.key == skill_key)
        .ok_or_else(|| format!("Skill '{}' was not found", skill_key))?;
    match known_skill.level {
        SkillLocation::User => {
            set_global_user_skill_disabled(skill_key, request.disabled)
                .await
                .map_err(|error| error.to_string())?;
        }
        SkillLocation::Project => {
            let record = workspace
                .as_ref()
                .ok_or_else(|| "Project Skill availability requires a workspace".to_string())?;
            set_global_project_skill_disabled(
                SkillPolicyWorkspace::from_record(record),
                skill_key,
                request.disabled,
            )
            .await
            .map_err(|error| error.to_string())?;
        }
    }
    if let Err(error) = openbitfun_core::service::config::reload_global_config().await {
        log::warn!("Failed to reload configuration after Skill availability update: skill_key={}, error={}", skill_key, error);
    }
    skill_availability_settings(workspace.as_ref()).await
}

#[tauri::command]
pub async fn get_mode_skill_configs(
    state: State<'_, AppState>,
    mode_id: String,
    force_refresh: Option<bool>,
    include_diagnostics: Option<bool>,
    workspace_id: Option<String>,
    workspace_path: Option<String>,
) -> Result<Value, String> {
    let workspace =
        resolve_skill_workspace(workspace_id.as_deref(), workspace_path.as_deref()).await?;
    let registry = SkillRegistry::global();

    if force_refresh.unwrap_or(false) {
        registry.refresh().await;
    }

    let mode_skill_infos = get_mode_skill_scan_report_for_workspace_input(
        &state,
        registry,
        &mode_id,
        workspace.as_ref(),
    )
    .await?;

    serialize_skill_scan_response(mode_skill_infos, include_diagnostics.unwrap_or(false))
        .map_err(|e| format!("Failed to serialize mode skill configs: {}", e))
}

#[tauri::command]
pub async fn set_mode_skill_disabled(
    state: State<'_, AppState>,
    mode_id: String,
    skill_key: String,
    disabled: bool,
    workspace_id: Option<String>,
    workspace_path: Option<String>,
) -> Result<String, String> {
    let workspace =
        resolve_skill_workspace(workspace_id.as_deref(), workspace_path.as_deref()).await?;
    if skill_key.starts_with("user::") {
        let registry = SkillRegistry::global();
        let skill_info = if let Some((remote_root, entry)) =
            resolve_remote_workspace(workspace.as_ref()).await?
        {
            let remote_fs = state
                .get_remote_file_service_async()
                .await
                .map_err(|e| format!("Remote file service not available: {}", e))?;
            let remote_workspace_fs = RemoteWorkspaceFs::new(entry, remote_fs);
            registry
                .find_skill_by_key_for_remote_workspace(
                    &remote_workspace_fs,
                    &remote_root,
                    &skill_key,
                )
                .await
        } else {
            registry
                .find_skill_by_key_for_workspace(
                    &skill_key,
                    workspace_root_from_input(workspace.as_ref()).as_deref(),
                )
                .await
        }
        .ok_or_else(|| format!("Skill '{}' not found", skill_key))?;

        let default_enabled = resolve_skill_default_enabled_for_mode(&skill_info, &mode_id);
        set_user_mode_skill_state(&mode_id, &skill_key, !disabled, default_enabled)
            .await
            .map_err(|e| format!("Failed to update user skill override: {}", e))?;
        if let Err(e) = openbitfun_core::service::config::reload_global_config().await {
            log::warn!(
                "Failed to reload global config after user skill override change: mode_id={}, skill_key={}, error={}",
                mode_id,
                skill_key,
                e
            );
        }
        return Ok(format!(
            "Mode '{}' skill '{}' updated successfully",
            mode_id, skill_key
        ));
    }

    if !skill_key.starts_with("project::") {
        return Err(format!("Unsupported skill key '{}'", skill_key));
    }

    if let Some((remote_root, entry)) = resolve_remote_workspace(workspace.as_ref()).await? {
        let remote_fs = state
            .get_remote_file_service_async()
            .await
            .map_err(|e| format!("Remote file service not available: {}", e))?;
        let config_path = project_mode_skills_path_for_remote(&remote_root);
        let mut document = if remote_fs
            .exists(&entry, &config_path)
            .await
            .map_err(|e| format!("Failed to check remote project skill overrides: {}", e))?
        {
            let content = remote_fs
                .read_file(&entry, &config_path)
                .await
                .map_err(|e| format!("Failed to read remote project skill overrides: {}", e))?;
            let content = String::from_utf8(content).map_err(|e| {
                format!("Remote project skill overrides are not valid UTF-8: {}", e)
            })?;
            deserialize_project_agent_profiles_document(&content)
                .map_err(|e| format!("Invalid remote project skill overrides JSON: {}", e))?
        } else {
            Default::default()
        };

        set_mode_skill_disabled_in_document(&mut document, &mode_id, &skill_key, disabled)
            .map_err(|e| format!("Failed to update remote project skill override: {}", e))?;

        let config_dir = config_path
            .rsplit_once('/')
            .map(|(dir, _)| dir.to_string())
            .ok_or_else(|| format!("Invalid remote project config path '{}'", config_path))?;

        remote_fs
            .create_dir_all(&entry, &config_dir)
            .await
            .map_err(|e| {
                format!(
                    "Failed to create remote project skill overrides directory: {}",
                    e
                )
            })?;
        remote_fs
            .write_file(
                &entry,
                &config_path,
                serialize_project_agent_profiles_document(&document)
                    .map_err(|e| {
                        format!("Failed to serialize remote project skill overrides: {}", e)
                    })?
                    .as_slice(),
            )
            .await
            .map_err(|e| format!("Failed to write remote project skill overrides: {}", e))?;
    } else {
        let workspace_root = workspace_root_from_input(workspace.as_ref())
            .ok_or_else(|| "Project-level skill overrides require an open workspace".to_string())?;
        let mut document = load_project_mode_skills_document_local(&workspace_root)
            .await
            .map_err(|e| format!("Failed to load project mode skills: {}", e))?;
        set_mode_skill_disabled_in_document(&mut document, &mode_id, &skill_key, disabled)
            .map_err(|e| format!("Failed to update project skill override: {}", e))?;
        save_project_mode_skills_document_local(&workspace_root, &document)
            .await
            .map_err(|e| format!("Failed to save project mode skills: {}", e))?;
    }

    Ok(format!(
        "Mode '{}' skill '{}' updated successfully",
        mode_id, skill_key
    ))
}

#[tauri::command]
pub async fn replace_mode_skill_selection(
    state: State<'_, AppState>,
    request: ReplaceModeSkillSelectionRequest,
) -> Result<String, String> {
    let workspace = resolve_skill_workspace(
        request.workspace_id.as_deref(),
        request.workspace_path.as_deref(),
    )
    .await?;
    let registry = SkillRegistry::global();
    let all_skills =
        get_all_skills_for_workspace_input(&state, registry, workspace.as_ref()).await?;

    let enabled_skill_keys = normalize_skill_key_list(request.enabled_skill_keys);
    let enabled_keys: HashSet<String> = enabled_skill_keys.iter().cloned().collect();
    let known_keys: HashSet<String> = all_skills.iter().map(|skill| skill.key.clone()).collect();
    let unknown_keys: Vec<String> = enabled_skill_keys
        .iter()
        .filter(|key| !known_keys.contains(*key))
        .cloned()
        .collect();
    if !unknown_keys.is_empty() {
        return Err(format!(
            "Unknown skill keys for mode '{}': {}",
            request.mode_id,
            unknown_keys.join(", ")
        ));
    }

    persist_user_mode_skill_selection(&request.mode_id, &all_skills, &enabled_keys).await?;

    let disabled_project_skills = normalize_skill_key_list(build_disabled_project_skill_keys(
        &all_skills,
        &enabled_keys,
    ));

    if let Some((remote_root, entry)) = resolve_remote_workspace(workspace.as_ref()).await? {
        persist_project_mode_skill_selection_remote(
            &state,
            &remote_root,
            &entry,
            &request.mode_id,
            disabled_project_skills,
        )
        .await?;
    } else if let Some(workspace_root) = workspace_root_from_input(workspace.as_ref()) {
        persist_project_mode_skill_selection_local(
            &request.mode_id,
            &workspace_root,
            disabled_project_skills,
        )
        .await?;
    }

    if let Err(e) = openbitfun_core::service::config::reload_global_config().await {
        log::warn!(
            "Failed to reload global config after batch skill update: mode_id={}, error={}",
            request.mode_id,
            e
        );
    }

    Ok(format!(
        "Mode '{}' skill selection updated successfully",
        request.mode_id
    ))
}

#[tauri::command]
pub async fn reset_mode_skill_selection(
    state: State<'_, AppState>,
    request: ResetModeSkillSelectionRequest,
) -> Result<String, String> {
    let workspace = resolve_skill_workspace(
        request.workspace_id.as_deref(),
        request.workspace_path.as_deref(),
    )
    .await?;
    clear_user_mode_skill_overrides(&request.mode_id)
        .await
        .map_err(|e| format!("Failed to reset user skill overrides: {}", e))?;

    if let Some((remote_root, entry)) = resolve_remote_workspace(workspace.as_ref()).await? {
        clear_project_mode_skill_selection_remote(&state, &remote_root, &entry, &request.mode_id)
            .await?;
    } else if let Some(workspace_root) = workspace_root_from_input(workspace.as_ref()) {
        clear_project_mode_skill_selection_local(&request.mode_id, &workspace_root).await?;
    }

    if let Err(e) = openbitfun_core::service::config::reload_global_config().await {
        log::warn!(
            "Failed to reload global config after resetting skill selection: mode_id={}, error={}",
            request.mode_id,
            e
        );
    }

    Ok(format!(
        "Mode '{}' skill selection reset successfully",
        request.mode_id
    ))
}

async fn resolve_external_skill_import_source(
    source_path: &str,
    source_key: &str,
    workspace: Option<&WorkspaceInfo>,
) -> Result<SkillInfo, String> {
    if let Some(record) = workspace {
        if record.workspace_kind == WorkspaceKind::Remote {
            return Err("External Skill import into remote workspaces is not supported".into());
        }
    }
    let source = SkillRegistry::global()
        .find_skill_by_key_for_workspace(
            source_key,
            workspace.map(|record| record.root_path.as_path()),
        )
        .await
        .ok_or("skill_import_stale: External Skill source changed; refresh before importing")?;
    if tokio::fs::canonicalize(&source.path)
        .await
        .map_err(|error| error.to_string())?
        != tokio::fs::canonicalize(source_path)
            .await
            .map_err(|error| error.to_string())?
    {
        return Err("External Skill path does not match the selected source".into());
    }
    Ok(source)
}

#[tauri::command]
pub async fn validate_skill_path(
    path: String,
    source_key: Option<String>,
    workspace_id: Option<String>,
    workspace_path: Option<String>,
) -> Result<SkillValidationResult, String> {
    let workspace =
        resolve_skill_workspace(workspace_id.as_deref(), workspace_path.as_deref()).await?;
    use std::path::Path;
    if let Some(source_key) = source_key {
        let source =
            resolve_external_skill_import_source(&path, &source_key, workspace.as_ref()).await?;
        let preview = skill_imports::preview_import(source).await?;
        return Ok(SkillValidationResult {
            valid: true,
            name: Some(preview.name.clone()),
            description: Some(preview.description.clone()),
            error: None,
            import_preview: Some(preview),
        });
    }

    let skill_path = Path::new(&path);

    if !skill_path.exists() {
        return Ok(SkillValidationResult {
            import_preview: None,
            valid: false,
            name: None,
            description: None,
            error: Some("Path does not exist".to_string()),
        });
    }

    if !skill_path.is_dir() {
        return Ok(SkillValidationResult {
            import_preview: None,
            valid: false,
            name: None,
            description: None,
            error: Some("Path is not a directory".to_string()),
        });
    }

    let skill_md_path = skill_path.join("SKILL.md");
    if !skill_md_path.exists() {
        return Ok(SkillValidationResult {
            import_preview: None,
            valid: false,
            name: None,
            description: None,
            error: Some("Directory is missing SKILL.md file".to_string()),
        });
    }

    match tokio::fs::read_to_string(&skill_md_path).await {
        Ok(content) => {
            match SkillData::from_markdown(path.clone(), &content, SkillLocation::User, false) {
                Ok(data) => Ok(SkillValidationResult {
                    import_preview: None,
                    valid: true,
                    name: Some(data.name),
                    description: Some(data.description),
                    error: None,
                }),
                Err(e) => Ok(SkillValidationResult {
                    import_preview: None,
                    valid: false,
                    name: None,
                    description: None,
                    error: Some(e.to_string()),
                }),
            }
        }
        Err(e) => Ok(SkillValidationResult {
            import_preview: None,
            valid: false,
            name: None,
            description: None,
            error: Some(format!("Failed to read SKILL.md: {}", e)),
        }),
    }
}

#[tauri::command]
pub async fn add_skill(
    _state: State<'_, AppState>,
    source_path: String,
    level: String,
    workspace_id: Option<String>,
    workspace_path: Option<String>,
    source_key: Option<String>,
    target_name: Option<String>,
    expected_source_fingerprint: Option<String>,
) -> Result<String, String> {
    let workspace =
        resolve_skill_workspace(workspace_id.as_deref(), workspace_path.as_deref()).await?;
    if let Some(source_key) = source_key {
        if !matches!(level.as_str(), "user" | "project") {
            return Err("Invalid Skill target scope".into());
        }
        let workspace_root = workspace_root_from_input(workspace.as_ref());
        let source =
            resolve_external_skill_import_source(&source_path, &source_key, workspace.as_ref())
                .await?;
        let paths = get_path_manager_arc();
        let target = if level == "project" {
            paths
                .project_root(workspace_root.as_deref().ok_or("No workspace selected")?)
                .join("skills")
        } else {
            paths.user_skills_dir()
        };
        skill_imports::import_copy_as_reviewed(
            source,
            target,
            target_name,
            expected_source_fingerprint,
        )
        .await?;
        SkillRegistry::global()
            .refresh_for_workspace(workspace_root.as_deref())
            .await;
        return Ok("External Skill imported successfully".into());
    }
    if target_name.is_some() || expected_source_fingerprint.is_some() {
        return Err("Reviewed or renamed Skill imports require their source identity".into());
    }
    let validation = validate_skill_path(source_path.clone(), None, None, None).await?;
    if !validation.valid {
        return Err(validation.error.unwrap_or("Invalid skill path".to_string()));
    }

    let skill_name = validation
        .name
        .as_ref()
        .ok_or_else(|| "Skill name missing after validation".to_string())?;
    let source = Path::new(&source_path);

    let target_dir = if level == "project" {
        if let Some(workspace_root) = workspace_root_from_input(workspace.as_ref()) {
            if workspace
                .as_ref()
                .is_some_and(|record| record.workspace_kind == WorkspaceKind::Remote)
            {
                return Err(
                    "Installing project skills into remote workspaces is not supported yet"
                        .to_string(),
                );
            }
            get_path_manager_arc()
                .project_root(&workspace_root)
                .join("skills")
        } else {
            return Err("No workspace open, cannot add project-level Skill".to_string());
        }
    } else {
        get_path_manager_arc().user_skills_dir()
    };

    if let Err(e) = tokio::fs::create_dir_all(&target_dir).await {
        return Err(format!("Failed to create skills directory: {}", e));
    }

    let folder_name = source
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("Unable to get folder name")?;

    let target_path = target_dir.join(folder_name);

    if target_path.exists() {
        return Err(format!(
            "Skill '{}' already exists in {} level directory",
            folder_name,
            if level == "project" {
                "project"
            } else {
                "user"
            }
        ));
    }

    if let Err(e) = copy_dir_all(source, &target_path).await {
        return Err(format!("Failed to copy skill folder: {}", e));
    }

    SkillRegistry::global()
        .refresh_for_workspace(workspace_root_from_input(workspace.as_ref()).as_deref())
        .await;

    info!(
        "Skill added: name={}, level={}, path={}",
        skill_name,
        level,
        target_path.display()
    );
    Ok(format!("Skill '{}' added successfully", skill_name))
}

async fn copy_dir_all(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    tokio::fs::create_dir_all(dst).await?;

    let mut entries = tokio::fs::read_dir(src).await?;
    while let Some(entry) = entries.next_entry().await? {
        let ty = entry.file_type().await?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());

        if ty.is_dir() {
            Box::pin(copy_dir_all(&src_path, &dst_path)).await?;
        } else {
            tokio::fs::copy(&src_path, &dst_path).await?;
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn delete_skill(
    state: State<'_, AppState>,
    skill_key: String,
    workspace_id: Option<String>,
    workspace_path: Option<String>,
    expected_import_id: Option<String>,
) -> Result<String, String> {
    let workspace =
        resolve_skill_workspace(workspace_id.as_deref(), workspace_path.as_deref()).await?;
    let registry = SkillRegistry::global();
    if let Some((remote_root, entry)) = resolve_remote_workspace(workspace.as_ref()).await? {
        if expected_import_id.is_some() {
            return Err("External Skill import undo on remote workspaces is not supported".into());
        }
        let remote_fs = state
            .get_remote_file_service_async()
            .await
            .map_err(|e| format!("Remote file service not available: {}", e))?;
        let remote_workspace_fs = RemoteWorkspaceFs::new(entry.clone(), remote_fs.clone());
        let skill_info = registry
            .find_skill_by_key_for_remote_workspace(&remote_workspace_fs, &remote_root, &skill_key)
            .await
            .ok_or_else(|| format!("Skill '{}' not found", skill_key))?;
        ensure_skill_can_be_deleted(&skill_info)?;

        match skill_info.level {
            SkillLocation::Project => {
                remote_fs
                    .remove_dir_all(&entry, &skill_info.path)
                    .await
                    .map_err(|e| format!("Failed to delete remote skill folder: {}", e))?;
                info!(
                    "Remote project skill deleted: key={}, path={}",
                    skill_key, skill_info.path
                );
            }
            SkillLocation::User => {
                let skill_path = std::path::PathBuf::from(&skill_info.path);
                if skill_path.exists() {
                    tokio::fs::remove_dir_all(&skill_path)
                        .await
                        .map_err(|e| format!("Failed to delete local skill folder: {}", e))?;
                }
                info!(
                    "Local user skill deleted in remote workspace context: key={}, path={}",
                    skill_key,
                    skill_path.display()
                );
            }
        }

        registry.refresh().await;

        return Ok(format!("Skill '{}' deleted successfully", skill_info.name));
    }

    let workspace_root = workspace_root_from_input(workspace.as_ref());
    let skill_info = registry
        .find_skill_by_key_for_workspace(&skill_key, workspace_root.as_deref())
        .await
        .ok_or_else(|| format!("Skill '{}' not found", skill_key))?;
    ensure_skill_can_be_deleted(&skill_info)?;

    let skill_path = std::path::PathBuf::from(&skill_info.path);

    if let Some(expected) = expected_import_id {
        skill_imports::remove_imported_copy(&skill_path, &expected).await?;
    } else if skill_path.exists() {
        if let Err(e) = tokio::fs::remove_dir_all(&skill_path).await {
            return Err(format!("Failed to delete skill folder: {}", e));
        }
    }

    registry
        .refresh_for_workspace(workspace_root.as_deref())
        .await;

    info!(
        "Skill deleted: key={}, path={}",
        skill_key,
        skill_path.display()
    );
    Ok(format!("Skill '{}' deleted successfully", skill_info.name))
}

#[cfg(test)]
mod tests {
    use super::{await_remote_skill_discovery, can_delete_owned_skill};
    use std::future;
    use tokio::time::Duration;

    #[test]
    fn skill_availability_accepts_legacy_and_workspace_scoped_requests() {
        let legacy =
            serde_json::json!({ "skillKey": "user::home.agents::review", "disabled": true });
        let request: super::SetGlobalSkillDisabledRequest =
            serde_json::from_value(legacy.clone()).unwrap();
        assert!(request.workspace_path.is_none());
        assert!(request.disabled);
        let mut scoped = legacy;
        scoped["workspacePath"] = serde_json::json!("/workspace/a");
        let request: super::SetGlobalSkillDisabledRequest = serde_json::from_value(scoped).unwrap();
        assert_eq!(request.workspace_path.as_deref(), Some("/workspace/a"));
        let request: super::GetGlobalSkillSettingsRequest =
            serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(request.workspace_path.is_none());
        let response = super::GlobalSkillSettingsResponse {
            globally_disabled_user_skill_keys: vec!["user::home.agents::review".into()],
            globally_disabled_project_skill_keys: vec!["project::agents::review".into()],
            direct_skill_management_version: 1,
        };
        let value = serde_json::to_value(response).unwrap();
        assert_eq!(value["directSkillManagementVersion"], 1);
        assert_eq!(
            value["globallyDisabledUserSkillKeys"][0],
            "user::home.agents::review"
        );
        assert_eq!(
            value["globallyDisabledProjectSkillKeys"][0],
            "project::agents::review"
        );
    }

    #[tokio::test]
    async fn skill_provider_uses_record_kind_and_saved_connection_not_its_root() {
        use openbitfun_core::service::workspace::WorkspaceInfoRuntimeExt;
        let root = tempfile::tempdir().unwrap();
        let mut local = super::WorkspaceInfo::new_without_worktree(
            root.path().to_path_buf(),
            Default::default(),
        )
        .await
        .unwrap();
        local
            .metadata
            .insert("connectionId".into(), serde_json::json!("stale-ssh"));
        assert!(super::resolve_remote_workspace(Some(&local))
            .await
            .unwrap()
            .is_none());
        let mut remote = local.clone();
        remote.id = "remote-id".into();
        remote.workspace_kind = super::WorkspaceKind::Remote;
        let target = super::resolve_remote_workspace(Some(&remote))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(target.1, "stale-ssh");
        remote.metadata.clear();
        assert!(super::resolve_remote_workspace(Some(&remote))
            .await
            .is_err());
    }

    #[test]
    fn skill_settings_accept_an_id_without_a_path() {
        let request: super::SetGlobalSkillDisabledRequest =
            serde_json::from_value(serde_json::json!({
                "workspaceId": "opaque-id", "skillKey": "project::agents::demo", "disabled": false,
            }))
            .unwrap();
        assert_eq!(request.workspace_id.as_deref(), Some("opaque-id"));
        assert!(request.workspace_path.is_none());
        let restored: super::SetGlobalSkillDisabledRequest =
            serde_json::from_value(serde_json::to_value(request).unwrap()).unwrap();
        assert_eq!(restored.workspace_id.as_deref(), Some("opaque-id"));
    }

    #[test]
    fn skill_validation_reads_and_round_trips_legacy_payloads() {
        let old = serde_json::json!({ "valid": true, "name": "demo", "description": "existing", "error": null });
        let parsed: super::SkillValidationResult = serde_json::from_value(old.clone()).unwrap();
        assert!(parsed.import_preview.is_none());
        assert_eq!(serde_json::to_value(parsed).unwrap(), old);
        let new = serde_json::json!({ "valid": true, "name": "demo", "description": "existing", "error": null,
            "importPreview": { "fingerprint": "reviewed", "fileCount": 2, "name": "demo", "description": "existing" } });
        let parsed: super::SkillValidationResult = serde_json::from_value(new.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), new);
    }

    #[tokio::test]
    async fn legacy_skill_path_validation_remains_available_without_source_identity() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(
            temp.path().join("SKILL.md"),
            "---\nname: demo\ndescription: Existing\n---\nBody",
        )
        .unwrap();
        let result = super::validate_skill_path(
            temp.path().to_string_lossy().into_owned(),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        assert!(result.valid);
        assert!(result.import_preview.is_none());
        assert_eq!(result.name.as_deref(), Some("demo"));
    }

    #[test]
    fn skill_scan_response_preserves_legacy_arrays_and_opt_in_diagnostics() {
        let report = super::SkillScanReport {
            skills: vec!["existing"],
            diagnostics: vec![
                openbitfun_core::agentic::tools::implementations::skills::SkillScanDiagnostic {
                    path: "/remote/denied".into(),
                    source_id: "codex".into(),
                    message: "permission denied".into(),
                },
            ],
        };
        assert_eq!(
            super::serialize_skill_scan_response(report.clone(), false).unwrap(),
            serde_json::json!(["existing"])
        );
        let value = super::serialize_skill_scan_response(report, true).unwrap();
        assert_eq!(value["skills"], serde_json::json!(["existing"]));
        assert_eq!(value["diagnostics"][0]["sourceId"], "codex");
    }

    #[tokio::test]
    async fn remote_skill_discovery_returns_before_the_deadline() {
        let result =
            await_remote_skill_discovery(async { Ok(vec!["skill"]) }, Duration::from_secs(1))
                .await
                .expect("ready discovery should complete");

        assert_eq!(result, vec!["skill"]);
    }

    #[tokio::test]
    async fn remote_skill_discovery_times_out_with_recovery_guidance() {
        let error = await_remote_skill_discovery(
            future::pending::<Result<(), String>>(),
            Duration::from_millis(1),
        )
        .await
        .expect_err("stalled discovery should time out");

        assert!(error.contains("Remote Skill discovery timed out"));
        assert!(error.contains("SSH/SFTP connection"));
        assert!(error.contains("retry"));
    }

    #[test]
    fn only_openbitfun_owned_non_builtin_skills_are_deletable() {
        assert!(can_delete_owned_skill("openbitfun", "openbitfun", false));
        assert!(can_delete_owned_skill("", "openbitfun", false));
        assert!(can_delete_owned_skill(
            "openbitfun-system",
            "openbitfun-system",
            false
        ));
        assert!(!can_delete_owned_skill(
            "openbitfun-system",
            "openbitfun-system",
            true
        ));
        assert!(!can_delete_owned_skill("opencode", "home.opencode", false));
        assert!(!can_delete_owned_skill("codex", "home.codex", false));
        assert!(!can_delete_owned_skill("future-ecosystem", "future", false));
        assert!(!can_delete_owned_skill("", "future", false));
        assert!(!can_delete_owned_skill("", "", false));
    }
}

#[tauri::command]
pub async fn list_skill_market(
    _state: State<'_, AppState>,
    request: SkillMarketListRequest,
) -> Result<Vec<SkillMarketItem>, String> {
    let query = request
        .query
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or(DEFAULT_MARKET_QUERY);
    let limit = normalize_market_limit(request.limit);
    fetch_skill_market(query, limit).await
}

#[tauri::command]
pub async fn search_skill_market(
    _state: State<'_, AppState>,
    request: SkillMarketSearchRequest,
) -> Result<Vec<SkillMarketItem>, String> {
    let query = request.query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let limit = normalize_market_limit(request.limit);
    fetch_skill_market(query, limit).await
}

#[tauri::command]
pub async fn download_skill_market(
    _state: State<'_, AppState>,
    request: SkillMarketDownloadRequest,
) -> Result<SkillMarketDownloadResponse, String> {
    let package = request.package.trim().to_string();
    if package.is_empty() {
        return Err("Skill package cannot be empty".to_string());
    }

    let level = request.level.unwrap_or(SkillLocation::Project);
    let workspace = resolve_skill_workspace(
        request.workspace_id.as_deref(),
        request.workspace_path.as_deref(),
    )
    .await?;
    let workspace_path = if level == SkillLocation::Project {
        let record = workspace
            .as_ref()
            .ok_or("No workspace open, cannot add project-level Skill")?;
        if record.workspace_kind == WorkspaceKind::Remote {
            return Err(
                "Downloading project skills into remote workspaces is not supported yet".into(),
            );
        }
        Some(record.root_path.clone())
    } else {
        None
    };

    let registry = SkillRegistry::global();
    let before_names: HashSet<String> = registry
        .get_all_skills_for_workspace(workspace_path.as_deref())
        .await
        .into_iter()
        .map(|skill| skill.name)
        .collect();

    let runtime_manager = RuntimeManager::new()
        .map_err(|e| format!("Failed to initialize runtime manager: {}", e))?;
    let resolved_npx = runtime_manager.resolve_command("npx").ok_or_else(|| {
        "Command 'npx' is not available. Install Node.js or configure OpenBitFun runtimes."
            .to_string()
    })?;

    let mut command = process_manager::create_tokio_command(&resolved_npx.command);
    command
        .arg("-y")
        .arg("skills")
        .arg("add")
        .arg(&package)
        .arg("-y")
        .arg("-a")
        .arg("universal");

    if level == SkillLocation::User {
        command.arg("-g");
    }

    if let Some(path) = workspace_path.as_ref() {
        command.current_dir(path);
    }

    let current_path = std::env::var("PATH").ok();
    if let Some(merged_path) = runtime_manager.merged_path_env(current_path.as_deref()) {
        command.env("PATH", &merged_path);
        #[cfg(windows)]
        {
            command.env("Path", &merged_path);
        }
    }

    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());

    let output = command
        .output()
        .await
        .map_err(|e| format!("Failed to execute skills installer: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() {
        let exit_code = output.status.code().unwrap_or(-1);
        let detail = if !stderr.trim().is_empty() {
            truncate_preview(stderr.trim())
        } else if !stdout.trim().is_empty() {
            truncate_preview(stdout.trim())
        } else {
            "Unknown installer error".to_string()
        };
        return Err(format!(
            "Failed to download skill package '{}' (exit code {}): {}",
            package, exit_code, detail
        ));
    }

    registry
        .refresh_for_workspace(workspace_path.as_deref())
        .await;
    let mut installed_skills: Vec<String> = registry
        .get_all_skills_for_workspace(workspace_path.as_deref())
        .await
        .into_iter()
        .map(|skill| skill.name)
        .filter(|name| !before_names.contains(name))
        .collect();
    installed_skills.sort();
    installed_skills.dedup();

    info!(
        "Skill market download completed: package={}, level={}, installed_count={}",
        package,
        level.as_str(),
        installed_skills.len()
    );

    Ok(SkillMarketDownloadResponse {
        package,
        level,
        installed_skills,
        output: summarize_command_output(&stdout, &stderr),
    })
}

fn normalize_market_limit(value: Option<u32>) -> u32 {
    value
        .unwrap_or(DEFAULT_MARKET_LIMIT)
        .clamp(1, MAX_MARKET_LIMIT)
}

async fn fetch_skill_market(query: &str, limit: u32) -> Result<Vec<SkillMarketItem>, String> {
    let api_base =
        std::env::var("SKILLS_API_URL").unwrap_or_else(|_| SKILLS_SEARCH_API_BASE.into());
    let base_url = api_base.trim_end_matches('/');
    let endpoint = format!("{}/api/search", base_url);

    crate::ensure_rustls_crypto_provider();
    let client = Client::new();
    let response = client
        .get(&endpoint)
        .query(&[("q", query), ("limit", &limit.to_string())])
        .send()
        .await
        .map_err(|e| format!("Failed to query skill market: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Skill market request failed with status {}",
            response.status()
        ));
    }

    let payload: SkillSearchApiResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to decode skill market response: {}", e))?;

    let mut seen_install_ids: HashSet<String> = HashSet::new();
    let mut items = Vec::new();

    for raw in payload.skills {
        let source = raw.source.trim().to_string();
        let install_id = if source.is_empty() {
            if raw.id.contains('@') {
                raw.id.clone()
            } else {
                format!("{}@{}", raw.id, raw.name)
            }
        } else {
            format!("{}@{}", source, raw.name)
        };

        if !seen_install_ids.insert(install_id.clone()) {
            continue;
        }

        items.push(SkillMarketItem {
            id: raw.id.clone(),
            name: raw.name,
            description: raw.description,
            source,
            installs: raw.installs,
            url: format!("{}/{}", base_url, raw.id.trim_start_matches('/')),
            install_id,
        });
    }

    fill_market_descriptions(&client, base_url, &mut items).await;

    Ok(items)
}

fn summarize_command_output(stdout: &str, stderr: &str) -> String {
    let primary = if !stdout.trim().is_empty() {
        stdout.trim()
    } else {
        stderr.trim()
    };

    if primary.is_empty() {
        return "Skill downloaded successfully.".to_string();
    }

    truncate_preview(primary)
}

fn truncate_preview(text: &str) -> String {
    if text.chars().count() <= MAX_OUTPUT_PREVIEW_CHARS {
        return text.to_string();
    }

    let truncated: String = text.chars().take(MAX_OUTPUT_PREVIEW_CHARS).collect();
    format!("{}...", truncated)
}

fn market_description_cache() -> &'static RwLock<HashMap<String, String>> {
    MARKET_DESCRIPTION_CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

async fn fill_market_descriptions(client: &Client, base_url: &str, items: &mut [SkillMarketItem]) {
    let cache = market_description_cache();

    {
        let reader = cache.read().await;
        for item in items.iter_mut() {
            if !item.description.trim().is_empty() {
                continue;
            }
            if let Some(cached) = reader.get(&item.id) {
                item.description = cached.clone();
            }
        }
    }

    let mut missing_ids = Vec::new();
    for item in items.iter() {
        if item.description.trim().is_empty() {
            missing_ids.push(item.id.clone());
        }
    }

    if missing_ids.is_empty() {
        return;
    }

    let mut join_set = JoinSet::new();
    let mut fetched = HashMap::new();

    for skill_id in missing_ids {
        let client_clone = client.clone();
        let page_url = format!("{}/{}", base_url, skill_id.trim_start_matches('/'));

        join_set.spawn(async move {
            let description = fetch_description_from_skill_page(&client_clone, &page_url).await;
            (skill_id, description)
        });

        if join_set.len() >= MARKET_DESC_FETCH_CONCURRENCY {
            if let Some(Ok((skill_id, Some(desc)))) = join_set.join_next().await {
                fetched.insert(skill_id, desc);
            }
        }
    }

    while let Some(result) = join_set.join_next().await {
        if let Ok((skill_id, Some(desc))) = result {
            fetched.insert(skill_id, desc);
        }
    }

    if fetched.is_empty() {
        return;
    }

    {
        let mut writer = cache.write().await;
        for (skill_id, desc) in &fetched {
            writer.insert(skill_id.clone(), desc.clone());
        }
    }

    for item in items.iter_mut() {
        if item.description.trim().is_empty() {
            if let Some(desc) = fetched.get(&item.id) {
                item.description = desc.clone();
            }
        }
    }
}

async fn fetch_description_from_skill_page(client: &Client, page_url: &str) -> Option<String> {
    let response = timeout(
        Duration::from_secs(MARKET_DESC_FETCH_TIMEOUT_SECS),
        client.get(page_url).send(),
    )
    .await
    .ok()?
    .ok()?;

    if !response.status().is_success() {
        return None;
    }

    let html = timeout(
        Duration::from_secs(MARKET_DESC_FETCH_TIMEOUT_SECS),
        response.text(),
    )
    .await
    .ok()?
    .ok()?;

    extract_description_from_html(&html)
}

fn extract_description_from_html(html: &str) -> Option<String> {
    if let Some(prose_index) = html.find("class=\"prose") {
        let scope = &html[prose_index..];
        if let Some(p_start) = scope.find("<p>") {
            let content = &scope[p_start + 3..];
            if let Some(p_end) = content.find("</p>") {
                let raw = &content[..p_end];
                let normalized = normalize_html_text(raw);
                if !normalized.is_empty() {
                    return Some(limit_text_len(&normalized, MARKET_DESC_MAX_LEN));
                }
            }
        }
    }

    if let Some(twitter_desc) = extract_meta_content(html, "twitter:description") {
        let normalized = normalize_html_text(&twitter_desc);
        if is_meaningful_meta_description(&normalized) {
            return Some(limit_text_len(&normalized, MARKET_DESC_MAX_LEN));
        }
    }

    None
}

fn extract_meta_content(html: &str, key: &str) -> Option<String> {
    let pattern = format!(r#"<meta name="{}" content="([^"]+)""#, regex::escape(key));
    let re = Regex::new(&pattern).ok()?;
    let caps = re.captures(html)?;
    Some(caps.get(1)?.as_str().to_string())
}

fn normalize_html_text(raw: &str) -> String {
    let without_tags = if let Ok(re) = Regex::new(r"<[^>]+>") {
        re.replace_all(raw, " ").into_owned()
    } else {
        raw.to_string()
    };

    without_tags
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

fn is_meaningful_meta_description(text: &str) -> bool {
    let lower = text.to_lowercase();
    if lower.is_empty() {
        return false;
    }

    if lower == "discover and install skills for ai agents." {
        return false;
    }

    !lower.starts_with("install the ")
}

fn limit_text_len(text: &str, max_len: usize) -> String {
    if text.chars().count() <= max_len {
        return text.to_string();
    }

    let mut truncated: String = text.chars().take(max_len).collect();
    truncated.push_str("...");
    truncated
}
