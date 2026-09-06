use super::app_state::AppState;
use openbitfun_core::miniapp::ai_bridge::{
    available_models_for_permissions, MiniAppAiModelDescriptor, MiniAppAiModelInfo,
};
use openbitfun_core::miniapp::{loopx::LoopxController, MiniAppCustomizationOriginKind, BUILTIN_APPS};
use openbitfun_core::service::config::types::GlobalConfig;
use openbitfun_product_domains::miniapp::builtin::builtin_source_matches;
use openbitfun_product_domains::miniapp::loopx::{
    LoopxActionRequest, LoopxActionResponse, LoopxAttachRequest, LoopxAttachResponse,
    LoopxCreateTaskRequest, LoopxCreateTaskResponse, LoopxEventsSinceRequest,
    LoopxEventsSinceResponse, LoopxExecutionDomain, LoopxExecutionSupport,
    LoopxResolveIntakeRequest, LoopxResolveIntakeResponse, LoopxTurnOutputSinceRequest,
    LoopxTurnOutputSinceResponse, LOOPX_BUILTIN_APP_ID,
};
use serde::Deserialize;
use std::sync::Arc;
use std::time::Instant;
use tauri::State;

pub const LOOPX_UNSUPPORTED_EXECUTION_DOMAIN: &str = "unsupported_execution_domain";

pub struct LoopxControllerState {
    pub controller: Arc<LoopxController>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiniAppLoopxAttachRequest {
    pub app_id: String,
    #[serde(flatten)]
    pub input: LoopxAttachRequest,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiniAppLoopxResolveIntakeRequest {
    pub app_id: String,
    #[serde(flatten)]
    pub input: LoopxResolveIntakeRequest,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiniAppLoopxCreateTaskRequest {
    pub app_id: String,
    #[serde(flatten)]
    pub input: LoopxCreateTaskRequest,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiniAppLoopxActionRequest {
    pub app_id: String,
    #[serde(flatten)]
    pub input: LoopxActionRequest,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiniAppLoopxEventsSinceRequest {
    pub app_id: String,
    #[serde(flatten)]
    pub input: LoopxEventsSinceRequest,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiniAppLoopxTurnOutputSinceRequest {
    pub app_id: String,
    #[serde(flatten)]
    pub input: LoopxTurnOutputSinceRequest,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiniAppLoopxListModelsRequest {
    pub app_id: String,
}

async fn authorize_builtin(state: &AppState, app_id: &str) -> Result<(), String> {
    if app_id != LOOPX_BUILTIN_APP_ID {
        return Err("LoopX controller is available only to the built-in LoopX MiniApp".to_string());
    }
    let builtin = BUILTIN_APPS
        .iter()
        .find(|app| app.id == LOOPX_BUILTIN_APP_ID)
        .ok_or_else(|| "Built-in LoopX bundle is unavailable".to_string())?;
    let app = state
        .miniapp_manager
        .get(app_id)
        .await
        .map_err(|error| format!("Failed to load built-in LoopX MiniApp: {error}"))?;
    if !builtin_source_matches(&app.source, builtin) {
        return Err("LoopX controller is disabled for modified MiniApp content".to_string());
    }
    if let Some(metadata) = state
        .miniapp_manager
        .load_customization_metadata(app_id)
        .await
        .map_err(|error| format!("Failed to load LoopX customization metadata: {error}"))?
    {
        if metadata.local_override
            || metadata.origin.kind != MiniAppCustomizationOriginKind::Builtin
            || metadata.origin.builtin_id.as_deref() != Some(LOOPX_BUILTIN_APP_ID)
        {
            return Err("LoopX controller is disabled for a local MiniApp override".to_string());
        }
    }
    Ok(())
}

async fn is_remote_workspace(state: &AppState) -> bool {
    state.remote_workspace.read().await.is_some()
}

fn unsupported_error() -> String {
    format!(
        "{LOOPX_UNSUPPORTED_EXECUTION_DOMAIN}: LoopX currently supports only a local Desktop workspace"
    )
}

/// List the host-configured chat models for the LoopX model picker. This is
/// gated on the same verified-builtin check as the controller bridge (not the
/// MiniApp AI permission), because the LoopX native agent selects the model.
#[tauri::command]
pub async fn miniapp_loopx_list_models(
    app_state: State<'_, AppState>,
    request: MiniAppLoopxListModelsRequest,
) -> Result<Vec<MiniAppAiModelInfo>, String> {
    authorize_builtin(&app_state, &request.app_id).await?;
    let global_config = app_state
        .config_service
        .get_config::<GlobalConfig>(None)
        .await
        .map_err(|error| error.to_string())?;
    let primary_id = global_config
        .ai
        .resolve_model_selection("primary")
        .unwrap_or_default();
    let fast_id = global_config
        .ai
        .resolve_model_selection("fast")
        .unwrap_or_default();
    let models = available_models_for_permissions(
        global_config
            .ai
            .models
            .iter()
            .map(|model| MiniAppAiModelDescriptor {
                id: model.id.clone(),
                name: model.name.clone(),
                model_name: model.model_name.clone(),
                provider: model.provider.clone(),
                enabled: model.enabled,
                supports_text_chat: model.supports_text_generation(),
            }),
        &[],
        &primary_id,
        &fast_id,
    );
    Ok(models)
}

#[tauri::command]
pub async fn miniapp_loopx_attach(
    app_state: State<'_, AppState>,
    controller: State<'_, LoopxControllerState>,
    request: MiniAppLoopxAttachRequest,
) -> Result<LoopxAttachResponse, String> {
    authorize_builtin(&app_state, &request.app_id).await?;
    if is_remote_workspace(&app_state).await {
        return Ok(controller
            .controller
            .attach(
                LoopxExecutionDomain::RemoteWorkspace,
                LoopxExecutionSupport::UnsupportedExecutionDomain,
                Some(unsupported_error()),
            )
            .await);
    }
    if request.input.resume_detected {
        let resume_controller = controller.controller.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = resume_controller.handle_host_resume().await {
                log::warn!("LoopX host resume reconciliation failed: {error}");
            }
        });
    }
    Ok(controller
        .controller
        .attach(
            LoopxExecutionDomain::LocalDesktop,
            LoopxExecutionSupport::Supported,
            None,
        )
        .await)
}

#[tauri::command]
pub async fn miniapp_loopx_resolve_intake(
    app_state: State<'_, AppState>,
    controller: State<'_, LoopxControllerState>,
    request: MiniAppLoopxResolveIntakeRequest,
) -> Result<LoopxResolveIntakeResponse, String> {
    authorize_builtin(&app_state, &request.app_id).await?;
    if is_remote_workspace(&app_state).await {
        return Err(unsupported_error());
    }
    controller.controller.resolve_intake(request.input).await
}

#[tauri::command]
pub async fn miniapp_loopx_create_task(
    app_state: State<'_, AppState>,
    controller: State<'_, LoopxControllerState>,
    request: MiniAppLoopxCreateTaskRequest,
) -> Result<LoopxCreateTaskResponse, String> {
    authorize_builtin(&app_state, &request.app_id).await?;
    if is_remote_workspace(&app_state).await {
        return Err(unsupported_error());
    }
    controller.controller.create_tasks(request.input).await
}

#[tauri::command]
pub async fn miniapp_loopx_action(
    app_state: State<'_, AppState>,
    controller: State<'_, LoopxControllerState>,
    request: MiniAppLoopxActionRequest,
) -> Result<LoopxActionResponse, String> {
    let started_at = Instant::now();
    let action = request.input.action;
    let request_id = request.input.client_request_id.clone();
    log::info!("LoopX action command received: action={action:?}, request_id={request_id}");
    let result = async {
        authorize_builtin(&app_state, &request.app_id).await?;
        if is_remote_workspace(&app_state).await {
            return Err(unsupported_error());
        }
        controller.controller.action(request.input).await
    }
    .await;
    let duration_ms = openbitfun_core::util::elapsed_ms_u64(started_at);
    match &result {
        Ok(response) => log::info!(
            "LoopX action command completed: action={action:?}, request_id={request_id}, status={:?}, duration_ms={duration_ms}",
            response.status
        ),
        Err(error) => log::warn!(
            "LoopX action command failed: action={action:?}, request_id={request_id}, duration_ms={duration_ms}, error={error}"
        ),
    }
    result
}

#[tauri::command]
pub async fn miniapp_loopx_events_since(
    app_state: State<'_, AppState>,
    controller: State<'_, LoopxControllerState>,
    request: MiniAppLoopxEventsSinceRequest,
) -> Result<LoopxEventsSinceResponse, String> {
    authorize_builtin(&app_state, &request.app_id).await?;
    if is_remote_workspace(&app_state).await {
        return Err(unsupported_error());
    }
    Ok(controller.controller.events_since(request.input).await)
}

#[tauri::command]
pub async fn miniapp_loopx_turn_output_since(
    app_state: State<'_, AppState>,
    controller: State<'_, LoopxControllerState>,
    request: MiniAppLoopxTurnOutputSinceRequest,
) -> Result<LoopxTurnOutputSinceResponse, String> {
    authorize_builtin(&app_state, &request.app_id).await?;
    if is_remote_workspace(&app_state).await {
        return Err(unsupported_error());
    }
    Ok(controller.controller.turn_output_since(request.input).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsupported_execution_domain_is_stable() {
        assert!(unsupported_error().starts_with(LOOPX_UNSUPPORTED_EXECUTION_DOMAIN));
    }
}
