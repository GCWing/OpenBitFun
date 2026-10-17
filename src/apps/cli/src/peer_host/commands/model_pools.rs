//! Peer adapters for the shared configuration and model selection owners.
use crate::peer_host::{
    args::{get_string, request_value},
    state::PeerHostState,
};
use serde_json::Value;

pub(crate) async fn dispatch(
    command: &str,
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    if matches!(
        command,
        "get_session_model_target" | "update_session_model_target"
    ) {
        let session_id = get_string(request, "sessionId")?;
        openbitfun_core_types::validate_session_id(&session_id)?;
        super::session::ensure_session_workspace_runtime_ownership(state, request).await?;
        if state
            .compatibility
            .loaded_session_snapshot(&session_id)
            .map_err(|error| error.to_string())?
            .is_none()
        {
            super::session::restore_session(state, args).await?;
        }
        let result = if command == "get_session_model_target" {
            state
                .agent_runtime
                .get_session_model_target(&session_id)
                .await
        } else {
            let selection = serde_json::from_value(
                request
                    .get("selection")
                    .cloned()
                    .ok_or("selection is required")?,
            )
            .map_err(|error| format!("Invalid model selection: {error}"))?;
            state
                .agent_runtime
                .update_session_model_target(&session_id, selection)
                .await
        }
        .map_err(|error| error.into_message())?;
        return serde_json::to_value(result).map_err(|error| error.to_string());
    }
    if command == "retry_model_pool_member" {
        state
            .compatibility
            .retry_model_pool_member(&get_string(request, "modelId")?)
            .await
            .map_err(|error| error.to_string())?;
        return Ok(Value::Null);
    }
    if command == "get_model_pool_status" {
        let statuses = state
            .compatibility
            .model_pool_statuses(&get_string(request, "poolId")?)
            .await
            .map_err(|error| error.to_string())?;
        return serde_json::to_value(statuses).map_err(|error| error.to_string());
    }
    let service = openbitfun_core::service::config::get_global_config_service()
        .await
        .map_err(|error| error.to_string())?;
    let store = service.model_pool_store().await;
    let document = match command {
        "get_model_pools" => store.read().await,
        "save_model_pool" => {
            let pool =
                serde_json::from_value(request.get("pool").cloned().ok_or("pool is required")?)
                    .map_err(|error| format!("Invalid model pool: {error}"))?;
            store.save(pool).await
        }
        "delete_model_pool" => store.delete(&get_string(request, "poolId")?).await,
        _ => return Err("Unsupported model pool operation".into()),
    }
    .map_err(|error| error.to_string())?;
    serde_json::to_value(document).map_err(|error| error.to_string())
}
