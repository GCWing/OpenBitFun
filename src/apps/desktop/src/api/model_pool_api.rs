//! Desktop transport for execution-host-owned model pools.

use crate::runtime::DesktopRuntimeContext;
use openbitfun_core::agentic::coordination::ConversationCoordinator;
use openbitfun_core::service::config::get_global_config_service;
use openbitfun_core::service::config::model_pool_store::{ModelPoolDefinition, ModelPoolDocument};
use openbitfun_core_types::model_pool::{
    ModelPoolMemberStatus, ModelSelection, SessionModelTarget,
};
use serde::Deserialize;
use std::sync::Arc;
use tauri::State;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveModelPoolRequest {
    pub pool: ModelPoolDefinition,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPoolRequest {
    pub pool_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionModelTargetRequest {
    pub session_id: String,
    #[serde(default)]
    pub selection: Option<ModelSelection>,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<String>,
    #[serde(default)]
    pub remote_connection_id: Option<String>,
    #[serde(default)]
    pub remote_ssh_host: Option<String>,
    #[serde(default)]
    pub include_internal: bool,
}

#[tauri::command]
pub async fn get_model_pools() -> Result<ModelPoolDocument, String> {
    let service = get_global_config_service()
        .await
        .map_err(|error| error.to_string())?;
    service
        .model_pool_store()
        .await
        .read()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn save_model_pool(request: SaveModelPoolRequest) -> Result<ModelPoolDocument, String> {
    let service = get_global_config_service()
        .await
        .map_err(|error| error.to_string())?;
    service
        .model_pool_store()
        .await
        .save(request.pool)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn delete_model_pool(request: ModelPoolRequest) -> Result<ModelPoolDocument, String> {
    let service = get_global_config_service()
        .await
        .map_err(|error| error.to_string())?;
    service
        .model_pool_store()
        .await
        .delete(&request.pool_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn get_model_pool_status(
    coordinator: State<'_, Arc<ConversationCoordinator>>,
    request: ModelPoolRequest,
) -> Result<Vec<ModelPoolMemberStatus>, String> {
    coordinator
        .model_pool_statuses(&request.pool_id)
        .await
        .map_err(|error| error.to_string())
}

async fn ensure_session(
    runtime: &DesktopRuntimeContext,
    request: &SessionModelTargetRequest,
) -> Result<(), String> {
    openbitfun_core_types::validate_session_id(&request.session_id)?;
    super::agentic_api::ensure_session_loaded_for_selector_update(
        runtime,
        &request.session_id,
        request.workspace_id.clone(),
        request.workspace_path.clone(),
        request.remote_connection_id.clone(),
        request.remote_ssh_host.clone(),
        request.include_internal,
    )
    .await
}

#[tauri::command]
pub async fn get_session_model_target(
    runtime: State<'_, DesktopRuntimeContext>,
    request: SessionModelTargetRequest,
) -> Result<SessionModelTarget, String> {
    ensure_session(runtime.inner(), &request).await?;
    runtime
        .agent_runtime()
        .get_session_model_target(&request.session_id)
        .await
        .map_err(|error| error.into_message())
}

#[tauri::command]
pub async fn update_session_model_target(
    runtime: State<'_, DesktopRuntimeContext>,
    request: SessionModelTargetRequest,
) -> Result<SessionModelTarget, String> {
    ensure_session(runtime.inner(), &request).await?;
    let selection = request
        .selection
        .ok_or_else(|| "selection is required".to_string())?;
    runtime
        .agent_runtime()
        .update_session_model_target(&request.session_id, selection)
        .await
        .map_err(|error| error.into_message())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetryModelPoolMemberRequest {
    pub model_id: String,
}

#[tauri::command]
pub async fn retry_model_pool_member(
    coordinator: State<'_, Arc<ConversationCoordinator>>,
    request: RetryModelPoolMemberRequest,
) -> Result<(), String> {
    coordinator
        .retry_model_pool_member(&request.model_id)
        .await
        .map_err(|error| error.to_string())
}
