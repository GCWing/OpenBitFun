//! Configuration API

use crate::api::app_state::AppState;
use crate::startup_trace::DesktopStartupTrace;
use log::{error, info};
use openbitfun_core::service::config::{
    ConfigExport, SaveCloudSpeechConfigRequest, SaveCloudSpeechConfigResult,
};
use openbitfun_core::util::errors::OpenBitFunError;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::time::Instant;
use tauri::State;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetConfigRequest {
    pub path: Option<String>,
    #[serde(default)]
    pub skip_retry_on_not_found: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetConfigsRequest {
    pub paths: Vec<String>,
    #[serde(default)]
    pub skip_retry_on_not_found: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetConfigRequest {
    pub path: String,
    pub value: Value,
    #[serde(default)]
    pub expected_models: Option<Value>,
}

#[derive(Debug, Deserialize)]
pub struct ResetConfigRequest {
    pub path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportConfigRequest {
    pub config_data: Value,
}

#[derive(Debug, Deserialize, Default)]
pub struct GetRuntimeLoggingInfoRequest {}

#[derive(Debug, Deserialize, Default)]
pub struct ExportDiagnosticsBundleRequest {}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendFlowChatDiagnosticsRequest {
    pub entries: Vec<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetWebSearchCredentialStatusRequest {
    pub provider: String,
}

fn to_json_value<T: Serialize>(value: T, context: &str) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|e| format!("Failed to serialize {}: {}", context, e))
}

fn is_expected_config_path_not_found(error: &OpenBitFunError, path: Option<&str>) -> bool {
    match (error, path) {
        (OpenBitFunError::NotFound(message), Some(path)) => {
            message == &format!("Config path '{}' not found", path)
        }
        _ => false,
    }
}

#[tauri::command]
pub async fn get_config(
    state: State<'_, AppState>,
    startup_trace: State<'_, DesktopStartupTrace>,
    request: GetConfigRequest,
) -> Result<Value, String> {
    let config_service = &state.config_service;
    let trace_started = Instant::now();
    let trace_target = request.path.clone();

    let result = match config_service
        .get_config::<Value>(request.path.as_deref())
        .await
    {
        Ok(config) => Ok(config),
        Err(e) => {
            if request.skip_retry_on_not_found
                && is_expected_config_path_not_found(&e, request.path.as_deref())
            {
                Err(format!("Failed to get config: {}", e))
            } else {
                error!("Failed to get config: path={:?}, error={}", request.path, e);
                Err(format!("Failed to get config: {}", e))
            }
        }
    };
    startup_trace.record_tauri_command_elapsed(
        "get_config",
        trace_target.as_deref(),
        trace_started,
    );
    result
}

#[tauri::command]
pub async fn get_configs(
    state: State<'_, AppState>,
    startup_trace: State<'_, DesktopStartupTrace>,
    request: GetConfigsRequest,
) -> Result<BTreeMap<String, Value>, String> {
    let config_service = &state.config_service;
    let mut configs = BTreeMap::new();
    let trace_started = Instant::now();
    let trace_target = request.paths.join(",");

    for path in request.paths {
        if configs.contains_key(&path) {
            continue;
        }

        match config_service
            .get_config::<Value>(Some(path.as_str()))
            .await
        {
            Ok(config) => {
                configs.insert(path, config);
            }
            Err(e) => {
                if request.skip_retry_on_not_found
                    && is_expected_config_path_not_found(&e, Some(path.as_str()))
                {
                    startup_trace.record_tauri_command_elapsed(
                        "get_configs",
                        Some(&trace_target),
                        trace_started,
                    );
                    return Err(format!("Failed to get config: {}", e));
                }
                error!("Failed to get config: path={}, error={}", path, e);
                startup_trace.record_tauri_command_elapsed(
                    "get_configs",
                    Some(&trace_target),
                    trace_started,
                );
                return Err(format!("Failed to get config: {}", e));
            }
        }
    }

    startup_trace.record_tauri_command_elapsed("get_configs", Some(&trace_target), trace_started);
    Ok(configs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_config_keeps_legacy_requests_and_accepts_an_explicit_model_snapshot() {
        let legacy: SetConfigRequest = serde_json::from_value(serde_json::json!({
            "path": "ai.models", "value": []
        }))
        .unwrap();
        assert!(legacy.expected_models.is_none());
        let guarded: SetConfigRequest = serde_json::from_value(serde_json::json!({
            "path": "ai.models", "value": [], "expectedModels": [{"id":"old"}]
        }))
        .unwrap();
        assert_eq!(
            guarded.expected_models,
            Some(serde_json::json!([{"id":"old"}]))
        );
    }

    #[test]
    fn recognizes_expected_config_path_not_found_errors() {
        let error = OpenBitFunError::NotFound(
            "Config path 'ai.review_team_rate_limit_status' not found".to_string(),
        );

        assert!(is_expected_config_path_not_found(
            &error,
            Some("ai.review_team_rate_limit_status"),
        ));
        assert!(!is_expected_config_path_not_found(
            &error,
            Some("ai.review_teams.default"),
        ));
        assert!(!is_expected_config_path_not_found(&error, None));
        assert!(!is_expected_config_path_not_found(
            &OpenBitFunError::config("Config path 'ai.review_team_rate_limit_status' not found"),
            Some("ai.review_team_rate_limit_status"),
        ));
    }
}

#[tauri::command]
pub async fn set_config(
    _state: State<'_, AppState>,
    app: tauri::AppHandle,
    startup_trace: State<'_, DesktopStartupTrace>,
    request: SetConfigRequest,
) -> Result<String, String> {
    let trace_started = Instant::now();
    let trace_target = request.path.clone();

    let result = match crate::openbitfun_control_host::set_config_from_gui(
        &app,
        &request.path,
        request.value,
        request.expected_models,
    )
    .await
    {
        Ok(_) => Ok("Configuration set successfully".to_string()),
        Err(error) => {
            error!(
                "Failed to set config through product control: path={}, error={}",
                request.path, error
            );
            Err(format!("Failed to set config: {error}"))
        }
    };
    startup_trace.record_tauri_command_elapsed(
        "set_config",
        Some(trace_target.as_str()),
        trace_started,
    );
    result
}

#[tauri::command]
pub async fn save_cloud_speech_config(
    state: State<'_, AppState>,
    request: SaveCloudSpeechConfigRequest,
) -> Result<SaveCloudSpeechConfigResult, String> {
    match state.config_service.save_cloud_speech_config(request).await {
        Ok(result) => {
            state.ai_client_factory.invalidate_cache();

            info!(
                "Cloud speech configuration saved atomically: model_id={}, created={}",
                result.model_id, result.created
            );
            Ok(result)
        }
        Err(error) => {
            error!("Failed to save cloud speech configuration: {}", error);
            Err(format!(
                "Failed to save cloud speech configuration: {}",
                error
            ))
        }
    }
}

#[tauri::command]
pub async fn get_web_search_credential_status(
    _state: State<'_, AppState>,
    request: GetWebSearchCredentialStatusRequest,
) -> Result<openbitfun_core::service::web_search::WebSearchCredentialStatus, String> {
    openbitfun_core::service::web_search::get_web_search_credential_status(&request.provider)
        .await
        .map_err(|error| format!("Failed to read WebSearch credential status: {error}"))
}

#[tauri::command]
pub async fn save_web_search_credential(
    _state: State<'_, AppState>,
    request: openbitfun_core::service::web_search::SaveWebSearchCredentialRequest,
) -> Result<openbitfun_core::service::web_search::WebSearchCredentialStatus, String> {
    openbitfun_core::service::web_search::save_web_search_credential(request)
        .await
        .map_err(|error| format!("Failed to save WebSearch credential: {error}"))
}

#[tauri::command]
pub async fn clear_web_search_credential(
    _state: State<'_, AppState>,
    request: openbitfun_core::service::web_search::ClearWebSearchCredentialRequest,
) -> Result<openbitfun_core::service::web_search::WebSearchCredentialStatus, String> {
    openbitfun_core::service::web_search::clear_web_search_credential(request)
        .await
        .map_err(|error| format!("Failed to clear WebSearch credential: {error}"))
}

#[tauri::command]
pub async fn reset_config(
    state: State<'_, AppState>,
    request: ResetConfigRequest,
) -> Result<String, String> {
    let config_service = &state.config_service;

    match config_service.reset_config(request.path.as_deref()).await {
        Ok(_) => {
            let message = if let Some(path) = &request.path {
                format!("Configuration '{}' reset successfully", path)
            } else {
                "All configurations reset successfully".to_string()
            };

            let should_invalidate = match &request.path {
                Some(path) => path.starts_with("ai"),
                None => true,
            };
            if should_invalidate {
                state.ai_client_factory.invalidate_cache();
                info!(
                    "AI config reset, cache invalidated: path={:?}",
                    request.path
                );
            }

            // Notify auto-sync: config reset, upload to relay

            Ok(message)
        }
        Err(e) => {
            error!(
                "Failed to reset config: path={:?}, error={}",
                request.path, e
            );
            Err(format!("Failed to reset config: {}", e))
        }
    }
}

#[tauri::command]
pub async fn export_config(state: State<'_, AppState>) -> Result<Value, String> {
    let config_service = &state.config_service;

    match config_service.export_config().await {
        Ok(export_data) => Ok(to_json_value(export_data, "export config data")?),
        Err(e) => {
            error!("Failed to export config: {}", e);
            Err(format!("Failed to export config: {}", e))
        }
    }
}

#[tauri::command]
pub async fn import_config(
    state: State<'_, AppState>,
    request: ImportConfigRequest,
) -> Result<Value, String> {
    let config_service = &state.config_service;
    let export: ConfigExport = serde_json::from_value(request.config_data)
        .map_err(|error| format!("Failed to parse OpenBitFun config export: {error}"))?;

    match config_service.import_config(export).await {
        Ok(result) => {
            if result.success {
                state.ai_client_factory.invalidate_cache();
                info!("Config imported, AI client cache invalidated");
            }
            Ok(to_json_value(result, "import config result")?)
        }
        Err(e) => {
            error!("Failed to import config: {}", e);
            Err(format!("Failed to import config: {}", e))
        }
    }
}

#[tauri::command]
pub async fn validate_config(state: State<'_, AppState>) -> Result<Value, String> {
    let config_service = &state.config_service;

    match config_service.validate_config().await {
        Ok(validation_result) => Ok(to_json_value(
            validation_result,
            "config validation result",
        )?),
        Err(e) => {
            error!("Failed to validate config: {}", e);
            Err(format!("Failed to validate config: {}", e))
        }
    }
}

#[tauri::command]
pub async fn reload_config(state: State<'_, AppState>) -> Result<String, String> {
    let config_service = &state.config_service;

    match config_service.reload().await {
        Ok(_) => {
            info!("Config reloaded");
            Ok("Configuration reloaded successfully".to_string())
        }
        Err(e) => {
            error!("Failed to reload config: {}", e);
            Err(format!("Failed to reload config: {}", e))
        }
    }
}

#[tauri::command]
pub async fn get_global_config_health() -> Result<bool, String> {
    Ok(openbitfun_core::service::config::GlobalConfigManager::is_initialized())
}

#[tauri::command]
pub async fn get_runtime_logging_info(
    startup_trace: State<'_, DesktopStartupTrace>,
    _state: State<'_, AppState>,
    _request: GetRuntimeLoggingInfoRequest,
) -> Result<Value, String> {
    let trace_started = Instant::now();
    let logging_info = crate::logging::get_runtime_logging_info();
    let result = to_json_value(logging_info, "runtime logging info");
    startup_trace.record_tauri_command_elapsed("get_runtime_logging_info", None, trace_started);
    result
}

#[tauri::command]
pub async fn export_diagnostics_bundle(
    _state: State<'_, AppState>,
    _request: ExportDiagnosticsBundleRequest,
) -> Result<Value, String> {
    let bundle_info = crate::crash_diagnostics::export_diagnostics_bundle()?;
    to_json_value(bundle_info, "diagnostics bundle info")
}

#[tauri::command]
pub async fn append_flow_chat_diagnostics(
    _state: State<'_, AppState>,
    request: AppendFlowChatDiagnosticsRequest,
) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::logging::append_flow_chat_diagnostics(&request.entries)
    })
    .await
    .map_err(|error| format!("Flow Chat diagnostics writer task failed: {}", error))?
}

#[tauri::command]
pub async fn get_agent_profile_configs(_state: State<'_, AppState>) -> Result<Value, String> {
    let agent_profiles =
        openbitfun_core::service::config::mode_config_canonicalizer::get_agent_profile_views()
            .await
            .map_err(|e| format!("Failed to get agent profile configs: {}", e))?;

    to_json_value(agent_profiles, "agent profile configs")
}

#[tauri::command]
pub async fn get_agent_profile_config(
    _state: State<'_, AppState>,
    agent_id: String,
) -> Result<Value, String> {
    let config =
        openbitfun_core::service::config::mode_config_canonicalizer::get_agent_profile_view(
            &agent_id,
        )
        .await
        .map_err(|e| format!("Failed to get agent profile config: {}", e))?;

    to_json_value(config, "agent profile config")
}

#[tauri::command]
pub async fn set_agent_profile_config(
    state: State<'_, AppState>,
    agent_id: String,
    config: Value,
) -> Result<String, String> {
    let _ = state;

    match openbitfun_core::service::config::mode_config_canonicalizer::persist_agent_profile_from_value(
        &agent_id, config,
    )
    .await
    {
        Ok(_) => Ok(format!("Agent profile for '{}' set successfully", agent_id)),
        Err(e) => {
            error!(
                "Failed to set agent profile config: agent_id={}, error={}",
                agent_id, e
            );
            Err(format!("Failed to set agent profile config: {}", e))
        }
    }
}

#[tauri::command]
pub async fn reset_agent_profile_config(
    _state: State<'_, AppState>,
    agent_id: String,
) -> Result<String, String> {
    match openbitfun_core::service::config::mode_config_canonicalizer::reset_agent_profile_to_default(
        &agent_id,
    )
    .await
    {
        Ok(_) => Ok(format!(
            "Agent profile for '{}' reset successfully",
            agent_id
        )),
        Err(e) => {
            error!(
                "Failed to reset agent profile config: agent_id={}, error={}",
                agent_id, e
            );
            Err(format!("Failed to reset agent profile config: {}", e))
        }
    }
}

#[tauri::command]
pub async fn canonicalize_agent_profile_configs(
    _state: State<'_, AppState>,
) -> Result<Value, String> {
    match openbitfun_core::service::config::mode_config_canonicalizer::canonicalize_agent_profile_configs(
    )
    .await {
        Ok(report) => {
            info!(
                "Agent profile configs canonicalized: removed_profiles={}, updated_profiles={}",
                report.removed_profile_configs.len(),
                report.updated_profiles.len()
            );
            Ok(to_json_value(
                report,
                "agent profile config canonicalization report",
            )?)
        }
        Err(e) => {
            error!("Failed to canonicalize agent profile configs: {}", e);
            Err(format!("Failed to canonicalize agent profile configs: {}", e))
        }
    }
}
