//! Subagent API

use crate::api::app_state::AppState;
use log::warn;
use openbitfun_core::agentic::agents::{
    AgentInfo, CustomSubagent, CustomSubagentDetail, CustomSubagentKind, SubAgentSource,
    SubagentListScope, SubagentQueryContext,
};
use openbitfun_core::service::config::SubagentModelSelection;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use tauri::State;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListSubagentsRequest {
    pub source: Option<SubAgentSource>,
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// Upgrade-only input for pre-ID clients.
    pub workspace_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListVisibleSubagentsRequest {
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// Upgrade-only input for pre-ID clients.
    pub workspace_path: Option<String>,
    pub parent_agent_type: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListManageableSubagentsRequest {
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// Upgrade-only input for pre-ID clients.
    pub workspace_path: Option<String>,
    pub parent_agent_type: String,
}

async fn query_workspace_from_request(
    state: &AppState,
    workspace_id: Option<&str>,
    legacy_path: Option<&str>,
) -> Result<(Option<String>, bool), String> {
    if workspace_id.is_none() && legacy_path.is_none() {
        return Ok((None, true));
    }
    let record = state
        .workspace_service
        .resolve_legacy_workspace_reference(
            workspace_id,
            legacy_path.unwrap_or_default(),
            None,
            None,
        )
        .await
        .map_err(|error| error.to_string())?
        .ok_or("Unknown workspace reference")?;
    let local = record.workspace_kind != openbitfun_core::service::workspace::WorkspaceKind::Remote;
    Ok((Some(record.id), local))
}

pub(super) async fn local_workspace_from_request(
    state: &AppState,
    workspace_id: Option<&str>,
    legacy_path: Option<&str>,
) -> Result<Option<String>, String> {
    let (id, local) = query_workspace_from_request(state, workspace_id, legacy_path).await?;
    if !local {
        return Err("Custom Agent management is unsupported for remote workspaces".into());
    }
    Ok(id)
}

fn reject_external_subagent_mutation(
    state: &AppState,
    subagent_id: &str,
    workspace: Option<&str>,
) -> Result<(), String> {
    if state
        .agent_registry
        .is_external_subagent_route(subagent_id, workspace)
    {
        return Err(
            "external_subagent_read_only: manage external agents in External AI Apps".to_string(),
        );
    }
    Ok(())
}

#[tauri::command]
pub async fn list_subagents(
    state: State<'_, AppState>,
    request: ListSubagentsRequest,
) -> Result<Vec<AgentInfo>, String> {
    let (workspace, external_sources_supported) = query_workspace_from_request(
        &state,
        request.workspace_id.as_deref(),
        request.workspace_path.as_deref(),
    )
    .await?;
    let query_workspace = external_sources_supported
        .then_some(workspace.as_deref())
        .flatten();
    let list = state
        .agent_registry
        .get_subagents_for_query(&SubagentQueryContext {
            parent_agent_type: None,
            workspace_id: query_workspace,
            list_scope: SubagentListScope::RegistryManagement,
            include_disabled: true,
            external_sources_supported,
        })
        .await;

    let result = match request.source {
        Some(source) => list
            .into_iter()
            .filter(|a| a.subagent_source == Some(source))
            .collect(),
        None => list,
    };

    Ok(result)
}

#[tauri::command]
pub async fn list_visible_subagents(
    state: State<'_, AppState>,
    request: ListVisibleSubagentsRequest,
) -> Result<Vec<AgentInfo>, String> {
    let (workspace, external_sources_supported) = query_workspace_from_request(
        &state,
        request.workspace_id.as_deref(),
        request.workspace_path.as_deref(),
    )
    .await?;
    let query_workspace = external_sources_supported
        .then_some(workspace.as_deref())
        .flatten();
    Ok(state
        .agent_registry
        .get_subagents_for_query(&SubagentQueryContext {
            parent_agent_type: Some(request.parent_agent_type.as_str()),
            workspace_id: query_workspace,
            list_scope: SubagentListScope::TaskVisible,
            include_disabled: false,
            external_sources_supported,
        })
        .await)
}

#[tauri::command]
pub async fn list_manageable_subagents(
    state: State<'_, AppState>,
    request: ListManageableSubagentsRequest,
) -> Result<Vec<AgentInfo>, String> {
    let (workspace, external_sources_supported) = query_workspace_from_request(
        &state,
        request.workspace_id.as_deref(),
        request.workspace_path.as_deref(),
    )
    .await?;
    let query_workspace = external_sources_supported
        .then_some(workspace.as_deref())
        .flatten();
    Ok(state
        .agent_registry
        .get_subagents_for_query(&SubagentQueryContext {
            parent_agent_type: Some(request.parent_agent_type.as_str()),
            workspace_id: query_workspace,
            list_scope: SubagentListScope::RegistryManagement,
            include_disabled: true,
            external_sources_supported,
        })
        .await)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetSubagentDetailRequest {
    pub subagent_id: String,
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// Upgrade-only input for pre-ID clients.
    pub workspace_path: Option<String>,
}

#[tauri::command]
pub async fn get_subagent_detail(
    state: State<'_, AppState>,
    request: GetSubagentDetailRequest,
) -> Result<CustomSubagentDetail, String> {
    let workspace = local_workspace_from_request(
        &state,
        request.workspace_id.as_deref(),
        request.workspace_path.as_deref(),
    )
    .await?;
    reject_external_subagent_mutation(&state, &request.subagent_id, workspace.as_deref())?;
    state
        .agent_registry
        .get_custom_subagent_detail(&request.subagent_id, workspace.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSubagentRequest {
    pub subagent_id: String,
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// Upgrade-only input for pre-ID clients.
    pub workspace_path: Option<String>,
}

#[tauri::command]
pub async fn delete_subagent(
    state: State<'_, AppState>,
    request: DeleteSubagentRequest,
) -> Result<(), String> {
    let subagent_id = request.subagent_id;
    let workspace = local_workspace_from_request(
        &state,
        request.workspace_id.as_deref(),
        request.workspace_path.as_deref(),
    )
    .await?;
    reject_external_subagent_mutation(&state, &subagent_id, workspace.as_deref())?;

    let file_path = state
        .agent_registry
        .remove_subagent(&subagent_id)
        .map_err(|e| e.to_string())?;

    if let Some(ref path) = file_path {
        if let Err(e) = std::fs::remove_file(path) {
            warn!("Failed to delete subagent file: path={}, error={}", path, e);
        }
    }

    if let Err(e) = openbitfun_core::service::config::reload_global_config().await {
        warn!(
            "Failed to reload global config after subagent deletion: subagent_id={}, error={}",
            subagent_id, e
        );
    }

    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSubagentRequest {
    pub subagent_id: String,
    pub description: String,
    pub prompt: String,
    pub tools: Option<Vec<String>>,
    pub readonly: Option<bool>,
    pub review: Option<bool>,
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// Upgrade-only input for pre-ID clients.
    pub workspace_path: Option<String>,
}

#[tauri::command]
pub async fn update_subagent(
    state: State<'_, AppState>,
    request: UpdateSubagentRequest,
) -> Result<(), String> {
    if request.description.trim().is_empty() {
        return Err("Description cannot be empty".to_string());
    }
    if request.prompt.trim().is_empty() {
        return Err("Prompt cannot be empty".to_string());
    }
    let workspace = local_workspace_from_request(
        &state,
        request.workspace_id.as_deref(),
        request.workspace_path.as_deref(),
    )
    .await?;
    reject_external_subagent_mutation(&state, &request.subagent_id, workspace.as_deref())?;
    state
        .agent_registry
        .update_custom_subagent_definition(
            &request.subagent_id,
            workspace.as_deref(),
            request.description.trim().to_string(),
            request.prompt.trim().to_string(),
            request.tools,
            request.readonly,
            request.review,
        )
        .await
        .map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SubagentLevel {
    User,
    Project,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSubagentRequest {
    pub level: SubagentLevel,
    pub name: String,
    pub description: String,
    pub prompt: String,
    pub tools: Option<Vec<String>>,
    pub readonly: Option<bool>,
    pub review: Option<bool>,
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// Upgrade-only input for pre-ID clients.
    pub workspace_path: Option<String>,
}

fn readonly_tool_names(state: &AppState) -> HashSet<String> {
    state
        .tool_registry
        .iter()
        .filter(|tool| tool.is_readonly())
        .map(|tool| tool.name().to_string())
        .collect()
}

fn ensure_review_tools_are_readonly(
    state: &AppState,
    agent_name: &str,
    tools: &[String],
) -> Result<(), String> {
    let readonly_tools = readonly_tool_names(state);
    let writable_tools: Vec<&str> = tools
        .iter()
        .map(String::as_str)
        .filter(|tool| !readonly_tools.contains(*tool))
        .collect();

    if writable_tools.is_empty() {
        return Ok(());
    }

    Err(format!(
        "Review Sub-Agent '{}' can only use read-only tools; remove writable tools: {}",
        agent_name,
        writable_tools.join(", ")
    ))
}

fn validate_agent_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("Name cannot be empty".to_string());
    }
    let mut chars = name.chars();
    if !chars.next().is_some_and(|c| c.is_ascii_alphabetic()) {
        return Err("Name must start with a letter".to_string());
    }
    for c in chars {
        if !c.is_ascii_alphanumeric() && c != '-' && c != '_' {
            return Err("Name can only contain letters, numbers, -, _".to_string());
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn create_subagent(
    state: State<'_, AppState>,
    request: CreateSubagentRequest,
) -> Result<(), String> {
    let name = request.name.trim();
    validate_agent_name(name)?;
    let workspace = local_workspace_from_request(
        &state,
        request.workspace_id.as_deref(),
        request.workspace_path.as_deref(),
    )
    .await?;

    if request.level == SubagentLevel::Project && workspace.is_none() {
        return Err("Project-level Agent requires opening a workspace first".to_string());
    }

    let modes = state.agent_registry.get_modes_info().await;
    let subagents = state
        .agent_registry
        .get_subagents_info(workspace.as_deref())
        .await;
    let existing: std::collections::HashSet<_> = modes
        .iter()
        .map(|m| m.id.as_str().to_lowercase())
        .chain(subagents.iter().map(|s| s.id.as_str().to_lowercase()))
        .collect();
    if existing.contains(name.to_lowercase().as_str()) {
        return Err(format!(
            "Name '{}' conflicts with existing mode or Sub Agent",
            name
        ));
    }

    let pm = state.workspace_service.path_manager();
    let agents_dir = match request.level {
        SubagentLevel::User => pm.user_agents_dir(),
        SubagentLevel::Project => {
            let id = workspace.as_deref().ok_or("Workspace ID not available")?;
            let record = state
                .workspace_service
                .require_workspace(id)
                .await
                .map_err(|error| error.to_string())?;
            pm.project_agents_dir(&record.root_path)
        }
    };

    std::fs::create_dir_all(&agents_dir)
        .map_err(|e| format!("Failed to create directory: {}", e))?;

    let tools = request.tools.filter(|t| !t.is_empty()).unwrap_or_else(|| {
        vec![
            "LS".to_string(),
            "Read".to_string(),
            "Glob".to_string(),
            "Grep".to_string(),
        ]
    });
    let kind = match request.level {
        SubagentLevel::User => CustomSubagentKind::User,
        SubagentLevel::Project => CustomSubagentKind::Project,
    };
    let file_path = agents_dir.join(format!("{}.md", name.to_lowercase()));
    let path_str = file_path.to_string_lossy().to_string();
    if file_path.exists() {
        return Err(format!("File '{}' already exists", path_str));
    }

    let review = request.review.unwrap_or(false);
    if review {
        ensure_review_tools_are_readonly(&state, name, &tools)?;
    }

    let readonly = if review {
        true
    } else {
        request.readonly.unwrap_or(true)
    };
    let mut subagent = CustomSubagent::new(
        name.to_string(),
        request.description.trim().to_string(),
        tools,
        request.prompt.trim().to_string(),
        readonly,
        path_str.clone(),
        kind,
    );
    subagent.set_review(review);
    subagent.save_to_file(None).map_err(|e| e.to_string())?;
    state
        .agent_registry
        .load_custom_agents(workspace.as_deref())
        .await;

    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReloadSubagentsRequest {
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// Upgrade-only input for pre-ID clients.
    pub workspace_path: Option<String>,
}

#[tauri::command]
pub async fn reload_subagents(
    state: State<'_, AppState>,
    request: ReloadSubagentsRequest,
) -> Result<(), String> {
    let workspace_root = local_workspace_from_request(
        &state,
        request.workspace_id.as_deref(),
        request.workspace_path.as_deref(),
    )
    .await?
    .ok_or_else(|| "workspaceId is required to reload project subagents".to_string())?;
    state
        .agent_registry
        .load_custom_subagents(workspace_root.as_str())
        .await;
    Ok(())
}

#[tauri::command]
pub async fn list_agent_tool_names(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let names: Vec<String> = state
        .tool_registry
        .iter()
        .map(|t| t.name().to_string())
        .collect();
    Ok(names)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSubagentConfigRequest {
    pub subagent_id: String,
    pub parent_agent_type: Option<String>,
    pub enabled: Option<bool>,
    pub model: Option<String>,
    #[serde(default)]
    pub clear_model_override: bool,
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// Upgrade-only input for pre-ID clients.
    pub workspace_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSubagentConfigResponse {
    pub availability_updated: bool,
    pub model_updated: bool,
}

#[tauri::command]
pub async fn update_subagent_config(
    state: State<'_, AppState>,
    request: UpdateSubagentConfigRequest,
) -> Result<UpdateSubagentConfigResponse, String> {
    let subagent_id = &request.subagent_id;
    let workspace = local_workspace_from_request(
        &state,
        request.workspace_id.as_deref(),
        request.workspace_path.as_deref(),
    )
    .await?;
    reject_external_subagent_mutation(&state, subagent_id, workspace.as_deref())?;
    if let Some(workspace) = workspace.as_deref() {
        state.agent_registry.load_custom_subagents(workspace).await;
    }

    let mut availability_updated = false;
    let mut model_updated = false;

    if request.model.is_some() && request.clear_model_override {
        return Err("model and clearModelOverride cannot be provided together".to_string());
    }

    if let Some(enabled) = request.enabled {
        let parent_agent_type = request.parent_agent_type.as_deref().ok_or_else(|| {
            "parentAgentType is required when updating subagent availability".to_string()
        })?;
        state
            .agent_registry
            .update_subagent_override(
                parent_agent_type,
                subagent_id,
                enabled,
                workspace.as_deref(),
            )
            .await
            .map_err(|e| format!("Failed to update subagent availability: {}", e))?;
        availability_updated = true;
    }

    if state
        .agent_registry
        .get_custom_subagent_config(subagent_id, workspace.as_deref())
        .is_some()
    {
        if request.model.is_some() || request.clear_model_override {
            state
                .agent_registry
                .update_and_save_custom_subagent_config(
                    subagent_id,
                    request.model,
                    request.clear_model_override,
                    workspace.as_deref(),
                )
                .map_err(|e| format!("Failed to update configuration: {}", e))?;
            model_updated = true;
        }
        Ok(UpdateSubagentConfigResponse {
            availability_updated,
            model_updated,
        })
    } else {
        if state
            .agent_registry
            .has_project_custom_subagent(subagent_id)
        {
            if let Some(workspace) = workspace.as_deref() {
                return Err(format!(
                    "Project Sub-Agent '{}' was not found in workspace '{}'",
                    subagent_id, workspace
                ));
            }

            return Err(format!(
                "workspaceId is required to update project Sub-Agent '{}'",
                subagent_id
            ));
        }

        let config_service = &state.config_service;

        if request.clear_model_override || request.model.is_some() {
            let mut builtin_models: std::collections::HashMap<String, SubagentModelSelection> =
                config_service
                    .get_config(Some("ai.agent_model_defaults.subagents.builtin"))
                    .await
                    .unwrap_or_default();
            if request.clear_model_override {
                builtin_models.remove(subagent_id);
            } else {
                let model = request
                    .model
                    .as_deref()
                    .expect("model checked above")
                    .trim();
                let selection = if model == "inherit" {
                    SubagentModelSelection::Inherit
                } else {
                    SubagentModelSelection::fixed(model)
                };
                builtin_models.insert(subagent_id.clone(), selection);
            }
            config_service
                .set_config("ai.agent_model_defaults.subagents.builtin", &builtin_models)
                .await
                .map_err(|e| format!("Failed to update model configuration: {}", e))?;
            model_updated = true;
        }

        if model_updated || availability_updated {
            if let Err(e) = openbitfun_core::service::config::reload_global_config().await {
                warn!(
                    "Failed to reload global config after subagent config update: subagent_id={}, error={}",
                    subagent_id, e
                );
            }
        }

        Ok(UpdateSubagentConfigResponse {
            availability_updated,
            model_updated,
        })
    }
}
