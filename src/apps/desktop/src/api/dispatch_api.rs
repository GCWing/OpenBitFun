//! SSH task dispatch Tauri adapter.
//!
//! The remote CLI owns the authoritative job and session. These commands are
//! thin host adapters around the platform-neutral dispatch controller and its
//! observer-only outbound index.

use std::sync::Arc;

use async_trait::async_trait;
use openbitfun_core::infrastructure::PathManager;
use openbitfun_core::service::dispatch::{
    answer_device_dispatch, answer_dispatch, append_device_dispatch, append_dispatch,
    cancel_device_dispatch, cancel_dispatch, cancel_dispatch_cli_install,
    continue_device_dispatch_job, continue_dispatch_job, decode_device_dispatch_response,
    encode_device_dispatch_command, get_device_dispatch_status, get_dispatch_status,
    list_device_dispatch_jobs, list_dispatch_jobs, list_dispatch_targets,
    poll_dispatch_cli_install, probe_device_dispatch_target, probe_dispatch_target,
    query_device_dispatch_job, query_dispatch_job, start_dispatch_cli_install,
    submit_device_dispatch, submit_dispatch, sync_device_dispatch_result,
    sync_dispatch_model_config, sync_dispatch_result, DeviceDispatchRpc, DispatchAnswerRequest,
    DispatchAppendRequest, DispatchConnectionRequest, DispatchContinueRequest,
    DispatchInstallPollRequest, DispatchInstallStartRequest, DispatchJobRequest,
    DispatchListJobsRequest, DispatchListTargetsRequest, DispatchProbeTargetRequest,
    DispatchQueryJobRequest, DispatchSaveTranscriptRequest, DispatchStatusRequest,
    DispatchSubmitRequest, DispatchSyncResultRequest, DispatchTarget, DispatchTargetOption,
    DispatchTargetRequest, DispatchTranscriptRequest, OutboundDispatchStore,
};
use openbitfun_core::service::dispatch::{
    execute_dispatch_control, DispatchAccountAccess, DispatchControlContext,
};
use openbitfun_core::service::remote_connect::account_runtime::AccountDevice;
use openbitfun_core::service::remote_ssh::dispatch_ssh::{
    self, DispatchInstallPoll, DispatchInstallStart, DispatchSshProbe,
};
use openbitfun_product_domains::detached_dispatch_control::DetachedDispatchControlRequest;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use super::app_state::AppState;

struct AccountDeviceDispatchRpc;

#[async_trait]
impl DeviceDispatchRpc for AccountDeviceDispatchRpc {
    async fn invoke(&self, device_id: &str, command: &str, args: Value) -> anyhow::Result<Value> {
        let command_json = encode_device_dispatch_command(command, args)?;
        let raw = super::remote_connect_api::account_device_rpc(
            device_id.to_string(),
            command_json,
            None,
        )
        .await
        .map_err(anyhow::Error::msg)?;
        decode_device_dispatch_response(command, &raw)
    }
}

/// Desktop account session for the shared Agent dispatch-control executor.
struct DesktopDispatchAccountAccess;

#[async_trait]
impl DispatchAccountAccess for DesktopDispatchAccountAccess {
    async fn list_devices(&self) -> anyhow::Result<Vec<AccountDevice>> {
        let devices = super::remote_connect_api::account_list_devices()
            .await
            .map_err(anyhow::Error::msg)?;
        Ok(devices
            .into_iter()
            .map(|device| AccountDevice {
                device_id: device.device_id,
                device_name: device.device_name,
                device_kind: device.device_kind,
                device_alias: device.device_alias,
                device_model: device.device_model,
                device_os: device.device_os,
                device_os_version: device.device_os_version,
                device_client_version: device.device_client_version,
                device_client_protocol: device.device_client_protocol,
                compatible: device.compatible,
                online: device.online,
            })
            .collect())
    }

    fn device_rpc(&self) -> Arc<dyn DeviceDispatchRpc> {
        Arc::new(AccountDeviceDispatchRpc)
    }
}

/// Run one Agent product-control dispatch request on this desktop.
pub(crate) async fn execute_agent_dispatch_control(
    state: &AppState,
    path_manager: &PathManager,
    request: DetachedDispatchControlRequest,
) -> Result<Value, String> {
    let store = OutboundDispatchStore::new(path_manager);
    let ssh = state
        .get_ssh_manager_async()
        .await
        .map_err(|error| error.to_string());
    let local_device_id = super::remote_connect_api::remote_connect_get_device_info()
        .await
        .ok()
        .map(|device| device.device_id);
    let context = DispatchControlContext {
        store: &store,
        ssh,
        account: Some(&DesktopDispatchAccountAccess),
        local_device_id,
    };
    execute_dispatch_control(&context, request)
        .await
        .map_err(|error| format!("{error:#}"))
}

#[tauri::command]
pub async fn dispatch_list_targets(
    state: State<'_, AppState>,
    request: DispatchListTargetsRequest,
) -> Result<Vec<DispatchTargetOption>, String> {
    let manager = state
        .get_ssh_manager_async()
        .await
        .map_err(|error| error.to_string())?;
    let mut targets = list_dispatch_targets(&manager, request)
        .await
        .map_err(|error| error.to_string())?;
    let current_device_id = super::remote_connect_api::remote_connect_get_device_info()
        .await
        .ok()
        .map(|device| device.device_id);
    if let Ok(devices) = super::remote_connect_api::account_list_devices().await {
        targets.extend(devices.into_iter().filter_map(|device| {
            if current_device_id.as_deref() == Some(device.device_id.as_str()) {
                return None;
            }
            Some(DispatchTargetOption {
                kind: "device".to_string(),
                connection_id: None,
                device_id: Some(device.device_id),
                display_name: device.device_name,
                description: None,
                online: Some(device.online),
            })
        }));
    }
    Ok(targets)
}

#[tauri::command]
pub async fn dispatch_probe_target(
    state: State<'_, AppState>,
    request: DispatchProbeTargetRequest,
) -> Result<DispatchSshProbe, String> {
    if matches!(&request.target, DispatchTargetRequest::Device { .. }) {
        return probe_device_dispatch_target(&AccountDeviceDispatchRpc, request)
            .await
            .map_err(|error| error.to_string());
    }
    let manager = state
        .get_ssh_manager_async()
        .await
        .map_err(|error| error.to_string())?;
    probe_dispatch_target(&manager, request)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn dispatch_install_cli_start(
    state: State<'_, AppState>,
    request: DispatchInstallStartRequest,
) -> Result<DispatchInstallStart, String> {
    let manager = state
        .get_ssh_manager_async()
        .await
        .map_err(|error| error.to_string())?;
    start_dispatch_cli_install(&manager, request)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn dispatch_install_cli_poll(
    state: State<'_, AppState>,
    request: DispatchInstallPollRequest,
) -> Result<DispatchInstallPoll, String> {
    let manager = state
        .get_ssh_manager_async()
        .await
        .map_err(|error| error.to_string())?;
    poll_dispatch_cli_install(&manager, request)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn dispatch_install_cli_cancel(
    state: State<'_, AppState>,
    request: DispatchConnectionRequest,
) -> Result<(), String> {
    let manager = state
        .get_ssh_manager_async()
        .await
        .map_err(|error| error.to_string())?;
    cancel_dispatch_cli_install(&manager, request)
        .await
        .map_err(|error| error.to_string())
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DispatchAccountBootstrapStatus {
    Synced,
    SkippedNotLoggedIn,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchProvisionTargetResult {
    pub account_status: DispatchAccountBootstrapStatus,
    pub daemon_installed: bool,
}

/// Finish a freshly installed SSH target without exposing account secrets to
/// the renderer: mint a distinct relay device, stage its bootstrap over SFTP,
/// install the user service, and prove that it connected before returning.
#[tauri::command]
pub async fn dispatch_provision_target(
    state: State<'_, AppState>,
    request: DispatchConnectionRequest,
) -> Result<DispatchProvisionTargetResult, String> {
    let connection_id = request.connection_id.trim();
    if connection_id.is_empty() {
        return Err("SSH connection id is required".to_string());
    }
    let manager = state
        .get_ssh_manager_async()
        .await
        .map_err(|error| error.to_string())?;
    let identity = dispatch_ssh::account_daemon_identity(&manager, connection_id)
        .await
        .map_err(|error| error.to_string())?;
    let Some(provisioning) =
        super::remote_connect_api::provision_dispatch_account_device(&identity).await?
    else {
        return Ok(DispatchProvisionTargetResult {
            account_status: DispatchAccountBootstrapStatus::SkippedNotLoggedIn,
            daemon_installed: false,
        });
    };

    let provision_result =
        dispatch_ssh::provision_account_daemon(&manager, connection_id, &provisioning.request)
            .await;
    if let Err(error) = provision_result {
        let _ = dispatch_ssh::deprovision_account_daemon(
            &manager,
            connection_id,
            provisioning.device_id(),
            provisioning.user_id(),
        )
        .await;
        let _ = super::remote_connect_api::remove_dispatch_account_device(&provisioning).await;
        return Err(format!("provision persistent OpenBitFun daemon: {error}"));
    }

    if let Err(error) =
        super::remote_connect_api::wait_for_dispatch_account_device_online(&provisioning).await
    {
        let _ = dispatch_ssh::deprovision_account_daemon(
            &manager,
            connection_id,
            provisioning.device_id(),
            provisioning.user_id(),
        )
        .await;
        let _ = super::remote_connect_api::remove_dispatch_account_device(&provisioning).await;
        return Err(error);
    }

    Ok(DispatchProvisionTargetResult {
        account_status: DispatchAccountBootstrapStatus::Synced,
        daemon_installed: true,
    })
}

#[tauri::command]
pub async fn dispatch_sync_model_config(
    state: State<'_, AppState>,
    request: DispatchConnectionRequest,
) -> Result<(), String> {
    let manager = state
        .get_ssh_manager_async()
        .await
        .map_err(|error| error.to_string())?;
    sync_dispatch_model_config(&manager, request)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn dispatch_submit(
    state: State<'_, AppState>,
    path_manager: State<'_, Arc<PathManager>>,
    request: DispatchSubmitRequest,
) -> Result<Value, String> {
    if let DispatchTargetRequest::Device { device_id, .. } = &request.target {
        let display_name = super::remote_connect_api::account_list_devices()
            .await
            .map_err(|error| format!("list account devices before dispatch: {error}"))?
            .into_iter()
            .find(|device| device.device_id == *device_id)
            .ok_or_else(|| "Dispatch device is not registered on the current account".to_string())
            .and_then(|device| {
                device.online.then_some(device.device_name).ok_or_else(|| {
                    "Dispatch device is offline; no local fallback was attempted".to_string()
                })
            })?;
        let store = OutboundDispatchStore::new(path_manager.as_ref());
        return submit_device_dispatch(&AccountDeviceDispatchRpc, &store, display_name, request)
            .await
            .map_err(|error| error.to_string());
    }
    let manager = state
        .get_ssh_manager_async()
        .await
        .map_err(|error| error.to_string())?;
    let store = OutboundDispatchStore::new(path_manager.as_ref());
    submit_dispatch(&manager, &store, request)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn dispatch_status(
    state: State<'_, AppState>,
    path_manager: State<'_, Arc<PathManager>>,
    request: DispatchStatusRequest,
) -> Result<Value, String> {
    let store = OutboundDispatchStore::new(path_manager.as_ref());
    if matches!(
        store
            .get(&request.job_id)
            .await
            .map_err(|error| error.to_string())?
            .map(|record| record.target),
        Some(DispatchTarget::Device { .. })
    ) {
        return get_device_dispatch_status(&AccountDeviceDispatchRpc, &store, request)
            .await
            .map_err(|error| error.to_string());
    }
    let manager = state
        .get_ssh_manager_async()
        .await
        .map_err(|error| error.to_string())?;
    get_dispatch_status(&manager, &store, request)
        .await
        .map_err(|error| error.to_string())
}

/// Bring a job's work back into the controller's baseline worktree.
///
/// One operation on purpose: the target commits and bundles, then this
/// controller fast-forwards its baseline onto the result. There is no separate
/// apply step because there is nothing to reconcile — both sides branched from
/// the same commit.
#[tauri::command]
pub async fn dispatch_sync_result(
    state: State<'_, AppState>,
    path_manager: State<'_, Arc<PathManager>>,
    request: DispatchSyncResultRequest,
) -> Result<Value, String> {
    let store = OutboundDispatchStore::new(path_manager.as_ref());
    if matches!(
        store
            .get(&request.job_id)
            .await
            .map_err(|error| error.to_string())?
            .map(|record| record.target),
        Some(DispatchTarget::Device { .. })
    ) {
        return sync_device_dispatch_result(&AccountDeviceDispatchRpc, &store, request)
            .await
            .map_err(|error| error.to_string());
    }
    let manager = state
        .get_ssh_manager_async()
        .await
        .map_err(|error| error.to_string())?;
    sync_dispatch_result(&manager, &store, request)
        .await
        .map_err(|error| error.to_string())
}

/// Start the next turn of a dispatch session.
///
/// A dispatch session is a conversation, not a single exchange: this reuses the
/// target's session, worktree, and event log, so the projection keeps growing
/// as one transcript.
#[tauri::command]
pub async fn dispatch_continue(
    state: State<'_, AppState>,
    path_manager: State<'_, Arc<PathManager>>,
    request: DispatchContinueRequest,
) -> Result<Value, String> {
    let store = OutboundDispatchStore::new(path_manager.as_ref());
    if matches!(
        store
            .get(&request.job_id)
            .await
            .map_err(|error| error.to_string())?
            .map(|record| record.target),
        Some(DispatchTarget::Device { .. })
    ) {
        return continue_device_dispatch_job(&AccountDeviceDispatchRpc, &store, request)
            .await
            .map_err(|error| error.to_string());
    }
    let manager = state
        .get_ssh_manager_async()
        .await
        .map_err(|error| error.to_string())?;
    continue_dispatch_job(&manager, &store, request)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn dispatch_query(
    state: State<'_, AppState>,
    path_manager: State<'_, Arc<PathManager>>,
    request: DispatchQueryJobRequest,
) -> Result<Value, String> {
    let store = OutboundDispatchStore::new(path_manager.as_ref());
    if matches!(
        store
            .get(&request.job_id)
            .await
            .map_err(|error| error.to_string())?
            .map(|record| record.target),
        Some(DispatchTarget::Device { .. })
    ) {
        return query_device_dispatch_job(&AccountDeviceDispatchRpc, &store, request)
            .await
            .map_err(|error| error.to_string());
    }
    let manager = state
        .get_ssh_manager_async()
        .await
        .map_err(|error| error.to_string())?;
    query_dispatch_job(&manager, &store, request)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn dispatch_cancel(
    state: State<'_, AppState>,
    path_manager: State<'_, Arc<PathManager>>,
    request: DispatchJobRequest,
) -> Result<Value, String> {
    let store = OutboundDispatchStore::new(path_manager.as_ref());
    if matches!(
        store
            .get(&request.job_id)
            .await
            .map_err(|error| error.to_string())?
            .map(|record| record.target),
        Some(DispatchTarget::Device { .. })
    ) {
        return cancel_device_dispatch(&AccountDeviceDispatchRpc, &store, request)
            .await
            .map_err(|error| error.to_string());
    }
    let manager = state
        .get_ssh_manager_async()
        .await
        .map_err(|error| error.to_string())?;
    cancel_dispatch(&manager, &store, request)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn dispatch_list_jobs(
    state: State<'_, AppState>,
    path_manager: State<'_, Arc<PathManager>>,
    request: DispatchListJobsRequest,
) -> Result<Value, String> {
    if let Some(DispatchTargetRequest::Device { device_id, .. }) = &request.target {
        let display_name = super::remote_connect_api::account_list_devices()
            .await
            .map_err(|error| format!("list account devices before observing dispatch: {error}"))?
            .into_iter()
            .find(|device| device.device_id == *device_id)
            .ok_or_else(|| "Dispatch device is not registered on the current account".to_string())
            .and_then(|device| {
                device.online.then_some(device.device_name).ok_or_else(|| {
                    "Dispatch device is offline; its jobs cannot be listed".to_string()
                })
            })?;
        let store = OutboundDispatchStore::new(path_manager.as_ref());
        return list_device_dispatch_jobs(&AccountDeviceDispatchRpc, &store, display_name, request)
            .await
            .map_err(|error| error.to_string());
    }
    let manager = state
        .get_ssh_manager_async()
        .await
        .map_err(|error| error.to_string())?;
    let store = OutboundDispatchStore::new(path_manager.as_ref());
    list_dispatch_jobs(&manager, &store, request)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn dispatch_answer(
    state: State<'_, AppState>,
    path_manager: State<'_, Arc<PathManager>>,
    request: DispatchAnswerRequest,
) -> Result<Value, String> {
    let store = OutboundDispatchStore::new(path_manager.as_ref());
    if matches!(
        store
            .get(&request.job_id)
            .await
            .map_err(|error| error.to_string())?
            .map(|record| record.target),
        Some(DispatchTarget::Device { .. })
    ) {
        return answer_device_dispatch(&AccountDeviceDispatchRpc, &store, request)
            .await
            .map_err(|error| error.to_string());
    }
    let manager = state
        .get_ssh_manager_async()
        .await
        .map_err(|error| error.to_string())?;
    answer_dispatch(&manager, &store, request)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn dispatch_append(
    state: State<'_, AppState>,
    path_manager: State<'_, Arc<PathManager>>,
    request: DispatchAppendRequest,
) -> Result<Value, String> {
    let store = OutboundDispatchStore::new(path_manager.as_ref());
    if matches!(
        store
            .get(&request.job_id)
            .await
            .map_err(|error| error.to_string())?
            .map(|record| record.target),
        Some(DispatchTarget::Device { .. })
    ) {
        return append_device_dispatch(&AccountDeviceDispatchRpc, &store, request)
            .await
            .map_err(|error| error.to_string());
    }
    let manager = state
        .get_ssh_manager_async()
        .await
        .map_err(|error| error.to_string())?;
    append_dispatch(&manager, &store, request)
        .await
        .map_err(|error| error.to_string())
}

/// Read this controller's cached observer transcript for one dispatch job.
///
/// Purely local: it touches neither the target nor any local session runtime.
/// A missing or unreadable cache returns `null` and the observer replays the
/// job from the beginning.
#[tauri::command]
pub async fn dispatch_load_transcript(
    path_manager: State<'_, Arc<PathManager>>,
    request: DispatchTranscriptRequest,
) -> Result<Option<Value>, String> {
    OutboundDispatchStore::new(path_manager.as_ref())
        .read_transcript(&request.job_id)
        .await
        .map_err(|error| error.to_string())
}

/// Persist this controller's observer transcript for one dispatch job.
///
/// A `null` transcript erases the cache instead, which is how deleting a
/// projection drops its cached content right away.
///
/// Returns `false` when the transcript exceeds the cache ceiling, in which case
/// the previous entry is kept and the renderer keeps polling as before.
#[tauri::command]
pub async fn dispatch_save_transcript(
    path_manager: State<'_, Arc<PathManager>>,
    request: DispatchSaveTranscriptRequest,
) -> Result<bool, String> {
    let store = OutboundDispatchStore::new(path_manager.as_ref());
    let Some(transcript) = request.transcript else {
        return store
            .remove_transcript(&request.job_id)
            .await
            .map(|()| true)
            .map_err(|error| error.to_string());
    };
    store
        .write_transcript(&request.job_id, &transcript)
        .await
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        decode_device_dispatch_response, DispatchAccountBootstrapStatus,
        DispatchProvisionTargetResult,
    };

    fn decode_device_dispatch_rpc(raw: &str) -> anyhow::Result<serde_json::Value> {
        decode_device_dispatch_response("dispatch_target_submit", raw)
    }

    #[test]
    fn device_dispatch_requires_a_correlated_host_invoke_acknowledgement() {
        let value = decode_device_dispatch_rpc(
            r#"{"resp":"host_invoke_result","ok":true,"value":{"accepted":true,"jobId":"job-1","sessionId":"session-1"}}"#,
        )
        .expect("true acknowledgement");
        assert_eq!(value["jobId"], "job-1");
        assert_eq!(value["sessionId"], "session-1");

        let rejected = decode_device_dispatch_rpc(
            r#"{"resp":"host_invoke_result","ok":false,"error":"target rejected"}"#,
        )
        .expect_err("negative acknowledgement");
        assert!(rejected.to_string().contains("target rejected"));
        assert!(decode_device_dispatch_rpc(r#"{"sent":true}"#).is_err());
    }

    #[test]
    fn target_provisioning_response_is_redacted_and_stable() {
        let value = serde_json::to_value(DispatchProvisionTargetResult {
            account_status: DispatchAccountBootstrapStatus::Synced,
            daemon_installed: true,
        })
        .unwrap();
        assert_eq!(value["accountStatus"], "synced");
        assert_eq!(value["daemonInstalled"], true);
        assert_eq!(value.as_object().unwrap().len(), 2);
    }
}
