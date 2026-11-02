//! System HostInvoke handlers.

use serde_json::{json, Value};

use openbitfun_core::service::token_usage::TokenUsageStatisticsRequest;

use crate::peer_host::state::PeerHostState;

pub(crate) async fn get_system_info() -> Result<Value, String> {
    let info = openbitfun_core::service::system::get_system_info();
    Ok(json!({
        "platform": info.platform,
        "arch": info.arch,
        "osVersion": info.os_version,
        "homeDir": info.home_dir,
    }))
}

pub(crate) async fn get_runtime_logging_info() -> Result<Value, String> {
    Ok(crate::logging::runtime_logging_info())
}

pub(crate) async fn get_token_usage_statistics(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = args
        .get("request")
        .cloned()
        .ok_or_else(|| "Missing 'request' field in args".to_string())?;
    let request: TokenUsageStatisticsRequest =
        serde_json::from_value(request).map_err(|error| error.to_string())?;
    let statistics = state
        .token_usage_service
        .get_statistics_for_request(request)
        .await
        .map_err(|error| error.to_string())?;
    serde_json::to_value(statistics).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn system_info_home_contract_reports_serving_host_in_camel_case() {
        let response = super::get_system_info().await.unwrap();
        let info = openbitfun_core::service::system::get_system_info();
        assert_eq!(response["homeDir"], serde_json::json!(info.home_dir));
        assert!(response.get("home_dir").is_none());
        assert_eq!(response["platform"], info.platform);
    }
}
