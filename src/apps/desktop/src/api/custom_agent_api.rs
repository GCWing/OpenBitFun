use super::subagent_api::local_workspace_from_request;
use crate::api::app_state::AppState;
use log::{debug, warn};
use openbitfun_core::agentic::agents::{
    custom_agent_model_or_default, custom_agent_review_writable_tools, default_custom_agent_tools,
    default_custom_agent_user_context_policy, CustomAgentDetail, CustomAgentKind, CustomAgentLevel,
    CustomMode, CustomSubagent, UserContextPolicy, UserContextSection,
};
use serde::Deserialize;
use std::collections::HashSet;
use tauri::State;

const AGENT_ID_REGEX: &str = "^[a-zA-Z][a-zA-Z0-9_-]*$";

fn reject_external_agent_mutation(
    state: &AppState,
    agent_id: &str,
    workspace: Option<&str>,
) -> Result<(), String> {
    if state
        .agent_registry
        .is_external_subagent_route(agent_id, workspace)
    {
        return Err(
            "external_subagent_read_only: manage external agents in External AI Apps".to_string(),
        );
    }
    Ok(())
}

fn validate_agent_id(id: &str) -> Result<(), String> {
    let id = id.trim();
    if id.is_empty() {
        return Err("Id cannot be empty".to_string());
    }
    let regex = regex::Regex::new(AGENT_ID_REGEX).map_err(|error| error.to_string())?;
    if !regex.is_match(id) {
        return Err(
            "Id must start with a letter and contain only letters, numbers, -, _".to_string(),
        );
    }
    Ok(())
}

fn validate_agent_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("Name cannot be empty".to_string());
    }
    Ok(())
}

fn policy_from_sections(
    sections: Option<Vec<UserContextSection>>,
    kind: CustomAgentKind,
) -> UserContextPolicy {
    sections
        .map(|sections| {
            let mut policy = UserContextPolicy::empty();
            for section in sections {
                policy = policy.with_section(section);
            }
            policy
        })
        .unwrap_or_else(|| default_custom_agent_user_context_policy(kind))
}

fn readonly_tool_names(state: &AppState) -> Vec<String> {
    state
        .tool_registry
        .iter()
        .filter(|tool| tool.is_readonly())
        .map(|tool| tool.name().to_string())
        .collect()
}

fn ensure_review_tools_are_readonly(
    state: &AppState,
    agent_id: &str,
    tools: &[String],
) -> Result<(), String> {
    let readonly_tools = readonly_tool_names(state);
    let writable_tools = custom_agent_review_writable_tools(tools, &readonly_tools);

    if writable_tools.is_empty() {
        return Ok(());
    }

    Err(format!(
        "Review Sub-Agent '{}' can only use read-only tools; remove writable tools: {}",
        agent_id,
        writable_tools.join(", ")
    ))
}

async fn existing_agent_ids(state: &AppState, workspace: Option<&str>) -> HashSet<String> {
    let modes = state.agent_registry.get_modes_info().await;
    let subagents = state.agent_registry.get_subagents_info(workspace).await;
    modes
        .iter()
        .map(|mode| mode.id.to_lowercase())
        .chain(subagents.iter().map(|agent| agent.id.to_lowercase()))
        .collect()
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetCustomAgentDetailRequest {
    pub agent_id: String,
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// Upgrade-only input for pre-ID clients.
    pub workspace_path: Option<String>,
}

#[tauri::command]
pub async fn get_custom_agent_detail(
    state: State<'_, AppState>,
    request: GetCustomAgentDetailRequest,
) -> Result<CustomAgentDetail, String> {
    let workspace = local_workspace_from_request(
        &state,
        request.workspace_id.as_deref(),
        request.workspace_path.as_deref(),
    )
    .await?;
    reject_external_agent_mutation(&state, &request.agent_id, workspace.as_deref())?;
    state
        .agent_registry
        .get_custom_agent_detail(&request.agent_id, workspace.as_deref())
        .await
        .map_err(|error| error.to_string())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCustomAgentRequest {
    pub kind: CustomAgentKind,
    pub level: Option<CustomAgentLevel>,
    pub id: String,
    pub name: String,
    pub description: String,
    pub prompt: String,
    pub tools: Option<Vec<String>>,
    pub readonly: Option<bool>,
    pub review: Option<bool>,
    pub model: Option<String>,
    pub user_context_policy: Option<Vec<UserContextSection>>,
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// Upgrade-only input for pre-ID clients.
    pub workspace_path: Option<String>,
}

#[tauri::command]
pub async fn create_custom_agent(
    state: State<'_, AppState>,
    request: CreateCustomAgentRequest,
) -> Result<(), String> {
    let id = request.id.trim().to_string();
    validate_agent_id(&id)?;
    validate_agent_name(&request.name)?;
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
    let level = request.level.unwrap_or(CustomAgentLevel::User);

    if request.kind == CustomAgentKind::Mode && level == CustomAgentLevel::Project {
        return Err("Custom modes do not support project level".to_string());
    }
    if level == CustomAgentLevel::Project && workspace.is_none() {
        return Err("Project-level Agent requires opening a workspace first".to_string());
    }

    state
        .agent_registry
        .load_custom_agents(workspace.as_deref())
        .await;

    let existing_ids = existing_agent_ids(&state, workspace.as_deref()).await;
    if existing_ids.contains(&id.to_lowercase()) {
        return Err(format!("Id '{}' conflicts with an existing agent", id));
    }

    let path_manager = state.workspace_service.path_manager();
    let agents_dir = match level {
        CustomAgentLevel::User => path_manager.user_agents_dir(),
        CustomAgentLevel::Project => {
            let id = workspace.as_deref().ok_or("Workspace ID not available")?;
            let record = state
                .workspace_service
                .require_workspace(id)
                .await
                .map_err(|error| error.to_string())?;
            path_manager.project_agents_dir(&record.root_path)
        }
    };
    std::fs::create_dir_all(&agents_dir)
        .map_err(|error| format!("Failed to create directory: {}", error))?;

    let file_path = agents_dir.join(format!("{}.md", id.to_lowercase()));
    let path_str = file_path.to_string_lossy().to_string();
    if file_path.exists() {
        return Err(format!("File '{}' already exists", path_str));
    }

    let mut tools = request
        .tools
        .filter(|items| !items.is_empty())
        .unwrap_or_else(|| {
            if request.kind == CustomAgentKind::Mode {
                warn!(
                    "Custom mode {} created without explicit tools; defaulting to minimal tool set",
                    id
                );
            }
            default_custom_agent_tools(request.kind)
        });
    if tools.is_empty() {
        tools = default_custom_agent_tools(request.kind);
    }

    let review = request.review.unwrap_or(false);
    if request.kind == CustomAgentKind::Mode && review {
        return Err("Custom modes cannot enable review".to_string());
    }
    if review {
        ensure_review_tools_are_readonly(&state, &id, &tools)?;
    }

    let readonly = if review {
        true
    } else {
        request
            .readonly
            .unwrap_or(request.kind == CustomAgentKind::Subagent)
    };
    let model_is_explicit = request
        .model
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty());
    let model = request
        .model
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| custom_agent_model_or_default(request.kind, None).to_string());
    let user_context_policy =
        policy_from_sections(request.user_context_policy.clone(), request.kind);

    match request.kind {
        CustomAgentKind::Mode => {
            let mode = CustomMode::new(
                id.clone(),
                request.name.trim().to_string(),
                request.description.trim().to_string(),
                tools,
                request.prompt.trim().to_string(),
                readonly,
                path_str.clone(),
                model.clone(),
                user_context_policy,
            );
            mode.save_to_file(None).map_err(|error| error.to_string())?;
        }
        CustomAgentKind::Subagent => {
            let mut subagent = CustomSubagent::new_with_id_and_model_explicit(
                id.clone(),
                request.name.trim().to_string(),
                request.description.trim().to_string(),
                tools,
                request.prompt.trim().to_string(),
                readonly,
                path_str.clone(),
                level,
                model.clone(),
                model_is_explicit,
                user_context_policy,
            );
            subagent.set_review(review);
            subagent
                .save_to_file(None)
                .map_err(|error| error.to_string())?;
        }
    }
    state
        .agent_registry
        .load_custom_agents(workspace.as_deref())
        .await;
    debug!("Created custom agent {} ({:?})", id, request.kind);

    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCustomAgentRequest {
    pub agent_id: String,
    pub name: String,
    pub description: String,
    pub prompt: String,
    pub tools: Option<Vec<String>>,
    pub readonly: Option<bool>,
    pub review: Option<bool>,
    pub model: Option<String>,
    pub user_context_policy: Option<Vec<UserContextSection>>,
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// Upgrade-only input for pre-ID clients.
    pub workspace_path: Option<String>,
}

#[tauri::command]
pub async fn update_custom_agent(
    state: State<'_, AppState>,
    request: UpdateCustomAgentRequest,
) -> Result<(), String> {
    validate_agent_name(&request.name)?;
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
    reject_external_agent_mutation(&state, &request.agent_id, workspace.as_deref())?;
    let current = state
        .agent_registry
        .get_custom_agent_detail(&request.agent_id, workspace.as_deref())
        .await
        .map_err(|error| error.to_string())?;

    let kind = match current.kind.as_str() {
        "mode" => CustomAgentKind::Mode,
        _ => CustomAgentKind::Subagent,
    };
    let user_context_policy = request
        .user_context_policy
        .clone()
        .map(|sections| policy_from_sections(Some(sections), kind));

    if kind == CustomAgentKind::Mode && request.review.unwrap_or(false) {
        return Err("Custom modes cannot enable review".to_string());
    }
    if kind == CustomAgentKind::Subagent && request.review.unwrap_or(current.review) {
        let tools = request
            .tools
            .clone()
            .filter(|items| !items.is_empty())
            .unwrap_or_else(|| current.tools.clone());
        ensure_review_tools_are_readonly(&state, &request.agent_id, &tools)?;
    }

    state
        .agent_registry
        .update_custom_agent_definition(
            &request.agent_id,
            workspace.as_deref(),
            request.name.trim().to_string(),
            request.description.trim().to_string(),
            request.prompt.trim().to_string(),
            request.tools.clone(),
            request.readonly,
            request.review,
            user_context_policy,
            request.model.clone(),
        )
        .await
        .map_err(|error| error.to_string())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteCustomAgentRequest {
    pub agent_id: String,
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// Upgrade-only input for pre-ID clients.
    pub workspace_path: Option<String>,
}

#[tauri::command]
pub async fn delete_custom_agent(
    state: State<'_, AppState>,
    request: DeleteCustomAgentRequest,
) -> Result<(), String> {
    let agent_id = request.agent_id;
    let workspace = local_workspace_from_request(
        &state,
        request.workspace_id.as_deref(),
        request.workspace_path.as_deref(),
    )
    .await?;
    reject_external_agent_mutation(&state, &agent_id, workspace.as_deref())?;

    if let Some(path) = state
        .agent_registry
        .remove_custom_agent(&agent_id)
        .map_err(|error| error.to_string())?
    {
        if let Err(error) = std::fs::remove_file(&path) {
            warn!(
                "Failed to delete custom agent file: path={}, error={}",
                path, error
            );
        }
    }

    let config_service = &state.config_service;

    if let Err(error) = config_service
        .update_config(
            "",
            |config: &mut openbitfun_core::service::config::GlobalConfig| {
                config.ai.agent_profiles.remove(&agent_id);
                config.app.flow_chat.remove_mode_reference(&agent_id);
                Ok(())
            },
        )
        .await
    {
        warn!(
            "Failed to clean up config after custom agent deletion: agent_id={}, error={}",
            agent_id, error
        );
    } else {
    }

    if let Err(error) = openbitfun_core::service::config::reload_global_config().await {
        warn!(
            "Failed to reload global config after custom agent deletion: agent_id={}, error={}",
            agent_id, error
        );
    }

    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReloadCustomAgentsRequest {
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// Upgrade-only input for pre-ID clients.
    pub workspace_path: Option<String>,
}

#[tauri::command]
pub async fn reload_custom_agents(
    state: State<'_, AppState>,
    request: ReloadCustomAgentsRequest,
) -> Result<(), String> {
    let workspace = local_workspace_from_request(
        &state,
        request.workspace_id.as_deref(),
        request.workspace_path.as_deref(),
    )
    .await?;
    state
        .agent_registry
        .load_custom_agents(workspace.as_deref())
        .await;
    Ok(())
}
