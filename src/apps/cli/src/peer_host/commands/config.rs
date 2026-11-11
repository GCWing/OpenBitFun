//! Config HostInvoke handlers for CLI Peer Host.

use std::collections::BTreeMap;

use serde_json::{json, Value};

use openbitfun_core::agentic::tools::openbitfun_control_config::global_shared_product_control_executor;
use openbitfun_core::service::config::get_global_config_service;
use openbitfun_core::util::errors::OpenBitFunError;

use crate::peer_host::args::{optional_bool, request_value};
use crate::peer_host::state::PeerHostState;

fn is_expected_config_path_not_found(error: &OpenBitFunError, path: Option<&str>) -> bool {
    match (error, path) {
        (OpenBitFunError::NotFound(message), Some(path)) => {
            message == &format!("Config path '{path}' not found")
        }
        _ => false,
    }
}

pub(crate) async fn get_config(args: &Value) -> Result<Value, String> {
    let request = request_value(args);
    let path = request
        .get("path")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty());
    let skip_retry_on_not_found = optional_bool(request, "skipRetryOnNotFound").unwrap_or(false);

    let config_service = get_global_config_service()
        .await
        .map_err(|e| format!("Failed to get config service: {e}"))?;

    match config_service.get_config::<Value>(path.as_deref()).await {
        Ok(config) => Ok(config),
        Err(e) => {
            if skip_retry_on_not_found && is_expected_config_path_not_found(&e, path.as_deref()) {
                return Err(format!("Failed to get config: {e}"));
            }
            tracing::error!("Failed to get config: path={path:?}, error={e}");
            Err(format!("Failed to get config: {e}"))
        }
    }
}

pub(crate) async fn get_configs(args: &Value) -> Result<Value, String> {
    let request = request_value(args);
    let paths = request
        .get("paths")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "Missing or invalid 'paths' field".to_string())?;
    let skip_retry_on_not_found = optional_bool(request, "skipRetryOnNotFound").unwrap_or(false);

    let config_service = get_global_config_service()
        .await
        .map_err(|e| format!("Failed to get config service: {e}"))?;

    let mut configs = BTreeMap::new();
    for path_value in paths {
        let path = path_value
            .as_str()
            .ok_or_else(|| "Invalid path entry in 'paths'".to_string())?
            .to_string();
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
                if skip_retry_on_not_found
                    && is_expected_config_path_not_found(&e, Some(path.as_str()))
                {
                    return Err(format!("Failed to get config: {e}"));
                }
                tracing::error!("Failed to get config: path={path}, error={e}");
                return Err(format!("Failed to get config: {e}"));
            }
        }
    }

    Ok(json!(configs))
}

pub(crate) async fn set_config(state: &PeerHostState, args: &Value) -> Result<Value, String> {
    let request = request_value(args);
    let path = request
        .get("path")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Missing or invalid 'path' field".to_string())?;
    let value = request
        .get("value")
        .cloned()
        .ok_or_else(|| "Missing 'value' field".to_string())?;

    let outcome = global_shared_product_control_executor()
        .await?
        .configure_legacy_path(&path, value)
        .await
        .map_err(|error| {
            tracing::error!(
                "Failed to set config through ProductControl: path={path}, error={error}"
            );
            format!("Failed to set config: {error}")
        })?;

    // Config changed on this host via a peer controller — schedule the cloud
    // push so other same-account devices converge.

    Ok(outcome)
}

pub(crate) async fn get_web_search_credential_status(args: &Value) -> Result<Value, String> {
    let request = request_value(args);
    let provider = request
        .get("provider")
        .and_then(Value::as_str)
        .ok_or_else(|| "Missing or invalid 'provider' field".to_string())?;
    let status = openbitfun_core::service::web_search::get_web_search_credential_status(provider)
        .await
        .map_err(|error| format!("Failed to read WebSearch credential status: {error}"))?;
    serde_json::to_value(status)
        .map_err(|error| format!("Failed to serialize WebSearch credential status: {error}"))
}

pub(crate) async fn save_web_search_credential(args: &Value) -> Result<Value, String> {
    let request = serde_json::from_value(request_value(args).clone())
        .map_err(|error| format!("Invalid WebSearch credential request: {error}"))?;
    let status = openbitfun_core::service::web_search::save_web_search_credential(request)
        .await
        .map_err(|error| format!("Failed to save WebSearch credential: {error}"))?;
    serde_json::to_value(status)
        .map_err(|error| format!("Failed to serialize WebSearch credential status: {error}"))
}

pub(crate) async fn clear_web_search_credential(args: &Value) -> Result<Value, String> {
    let request = serde_json::from_value(request_value(args).clone())
        .map_err(|error| format!("Invalid WebSearch credential clear request: {error}"))?;
    let status = openbitfun_core::service::web_search::clear_web_search_credential(request)
        .await
        .map_err(|error| format!("Failed to clear WebSearch credential: {error}"))?;
    serde_json::to_value(status)
        .map_err(|error| format!("Failed to serialize WebSearch credential status: {error}"))
}

pub(crate) async fn get_decision_model_credential_status(_args: &Value) -> Result<Value, String> {
    let status = openbitfun_core::service::decision_model::get_credential_status()
        .await
        .map_err(|error| format!("Failed to read decision-model credential status: {error}"))?;
    serde_json::to_value(status)
        .map_err(|error| format!("Failed to serialize decision-model credential status: {error}"))
}

pub(crate) async fn save_decision_model_credential(args: &Value) -> Result<Value, String> {
    let request = serde_json::from_value(request_value(args).clone())
        .map_err(|error| format!("Invalid decision-model credential request: {error}"))?;
    let status = openbitfun_core::service::decision_model::save_credential(request)
        .await
        .map_err(|error| format!("Failed to save decision-model credential: {error}"))?;
    serde_json::to_value(status)
        .map_err(|error| format!("Failed to serialize decision-model credential status: {error}"))
}

pub(crate) async fn clear_decision_model_credential(_args: &Value) -> Result<Value, String> {
    let status = openbitfun_core::service::decision_model::clear_credential()
        .await
        .map_err(|error| format!("Failed to clear decision-model credential: {error}"))?;
    serde_json::to_value(status)
        .map_err(|error| format!("Failed to serialize decision-model credential status: {error}"))
}

pub(crate) async fn get_agent_profile_config(args: &Value) -> Result<Value, String> {
    // Desktop Tauri takes top-level `agentId` (not always under `request`).
    let agent_id = crate::peer_host::args::get_string(args, "agentId")
        .or_else(|_| crate::peer_host::args::get_string(request_value(args), "agentId"))?;

    let config =
        openbitfun_core::service::config::mode_config_canonicalizer::get_agent_profile_view(
            &agent_id,
        )
        .await
        .map_err(|e| format!("Failed to get agent profile config: {e}"))?;
    serde_json::to_value(config).map_err(|e| format!("Failed to serialize agent profile: {e}"))
}

pub(crate) async fn get_agent_profile_configs() -> Result<Value, String> {
    let configs =
        openbitfun_core::service::config::mode_config_canonicalizer::get_agent_profile_views()
            .await
            .map_err(|e| format!("Failed to get agent profile configs: {e}"))?;
    serde_json::to_value(configs)
        .map_err(|e| format!("Failed to serialize agent profile configs: {e}"))
}
