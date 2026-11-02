//! Soft / empty responses for Desktop subsystems CLI Peer Host does not run.

use serde_json::{json, Value};

/// The embedded CLI starts scheduling during bootstrap; repeated readiness
/// signals from peer controllers are idempotent.
pub(crate) async fn notify_cron_host_ready() -> Result<Value, String> {
    let service = openbitfun_core::service::cron::get_global_cron_service()
        .ok_or_else(|| "Scheduled jobs are unavailable in this execution host".to_string())?;
    service.start();
    Ok(Value::Null)
}

/// MiniApps are a Desktop-hosted runtime; return empty catalog so hydrate succeeds.
pub(crate) async fn list_miniapps() -> Result<Value, String> {
    Ok(json!([]))
}

pub(crate) async fn miniapp_worker_list_running() -> Result<Value, String> {
    Ok(json!([]))
}

/// ACP client list for Desktop settings UI; CLI peer returns none for now.
pub(crate) async fn get_acp_clients() -> Result<Value, String> {
    Ok(json!([]))
}

pub(crate) async fn list_background_command_activities() -> Result<Value, String> {
    Ok(json!({ "activities": [] }))
}
