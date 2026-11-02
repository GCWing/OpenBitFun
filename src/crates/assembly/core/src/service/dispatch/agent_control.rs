//! Agent-facing Detached Dispatch controller shared by every product host.
//!
//! Desktop and CLI bind the `detached-dispatch` product-control provider to
//! [`execute_dispatch_control`]; the CLI `dispatch outbound` command reuses the
//! same target resolution. Hosts supply only their account session and SSH
//! manager, so device discovery, target resolution, and routing cannot drift.

use std::sync::Arc;

use anyhow::{anyhow, bail};
use async_trait::async_trait;
use openbitfun_product_domains::detached_dispatch_control::{
    DetachedDispatchControlRequest, MAX_DETACHED_DISPATCH_PROMPT_BYTES,
};
use serde_json::{json, Value};

use super::{
    cancel_device_dispatch, cancel_dispatch, get_device_dispatch_status, get_dispatch_status,
    list_device_dispatch_jobs, list_dispatch_jobs, list_dispatch_targets, submit_device_dispatch,
    submit_dispatch, AccountRuntimeDeviceDispatchRpc, DeviceDispatchRpc, DispatchJobRequest,
    DispatchListJobsRequest, DispatchListTargetsRequest, DispatchStatusRequest,
    DispatchSubmitRequest, DispatchTarget, DispatchTargetRequest, OutboundDispatchStore,
};
use crate::service::remote_connect::account_runtime::{AccountDevice, AccountRuntime};
use crate::service::remote_ssh::SSHConnectionManager;

/// The executing host's account session, as seen by the dispatch controller.
#[async_trait]
pub trait DispatchAccountAccess: Send + Sync {
    /// Every device on the account, this host included. Errors when signed out.
    async fn list_devices(&self) -> anyhow::Result<Vec<AccountDevice>>;
    fn device_rpc(&self) -> Arc<dyn DeviceDispatchRpc>;
}

/// [`DispatchAccountAccess`] over a Core [`AccountRuntime`].
pub struct AccountRuntimeDispatchAccess {
    account: Arc<AccountRuntime>,
}

impl AccountRuntimeDispatchAccess {
    pub fn new(account: Arc<AccountRuntime>) -> Self {
        Self { account }
    }
}

#[async_trait]
impl DispatchAccountAccess for AccountRuntimeDispatchAccess {
    async fn list_devices(&self) -> anyhow::Result<Vec<AccountDevice>> {
        if !self.account.is_logged_in().await {
            bail!("This host is not signed in to an OpenBitFun account");
        }
        self.account.list_devices().await
    }

    fn device_rpc(&self) -> Arc<dyn DeviceDispatchRpc> {
        Arc::new(AccountRuntimeDeviceDispatchRpc::new(self.account.clone()))
    }
}

/// Host resources for one dispatch-control call.
pub struct DispatchControlContext<'a> {
    pub store: &'a OutboundDispatchStore,
    /// `Err` carries why SSH targets are unavailable on this host.
    pub ssh: Result<SSHConnectionManager, String>,
    /// `None` when this host has no account runtime at all.
    pub account: Option<&'a dyn DispatchAccountAccess>,
    /// This host's device identity, used to mark and exclude itself.
    pub local_device_id: Option<String>,
}

/// A target resolved from a user- or Agent-supplied selector.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolvedDispatchTarget {
    Device {
        device_id: String,
        display_name: String,
    },
    Ssh {
        connection_id: String,
    },
}

impl ResolvedDispatchTarget {
    pub fn request(&self) -> DispatchTargetRequest {
        // The target chooses where its worktree lands.
        match self {
            Self::Device { device_id, .. } => DispatchTargetRequest::Device {
                device_id: device_id.clone(),
                workspace_path: String::new(),
            },
            Self::Ssh { connection_id } => DispatchTargetRequest::Ssh {
                connection_id: connection_id.clone(),
                workspace_path: String::new(),
            },
        }
    }
}

pub fn device_label(device: &AccountDevice) -> String {
    device
        .device_alias
        .as_deref()
        .map(str::trim)
        .filter(|alias| !alias.is_empty())
        .unwrap_or(&device.device_name)
        .to_string()
}

/// Resolve `ssh:<connectionId>`, `device:<deviceId>`, a device ID, or an
/// exact (case-insensitive) device name or alias. `devices` must already
/// exclude this host. Names must match exactly one device.
pub fn resolve_dispatch_target(
    selector: &str,
    devices: &[AccountDevice],
) -> anyhow::Result<ResolvedDispatchTarget> {
    let selector = selector.trim();
    if let Some(connection_id) = selector.strip_prefix("ssh:") {
        let connection_id = connection_id.trim();
        if connection_id.is_empty() {
            bail!("ssh: targets need a saved connection id");
        }
        return Ok(ResolvedDispatchTarget::Ssh {
            connection_id: connection_id.to_string(),
        });
    }
    let matches: Vec<&AccountDevice> = match selector.strip_prefix("device:") {
        Some(device_id) => devices
            .iter()
            .filter(|device| device.device_id == device_id.trim())
            .collect(),
        None => {
            let by_id: Vec<_> = devices
                .iter()
                .filter(|device| device.device_id == selector)
                .collect();
            if by_id.is_empty() {
                devices
                    .iter()
                    .filter(|device| {
                        device.device_name.eq_ignore_ascii_case(selector)
                            || device
                                .device_alias
                                .as_deref()
                                .is_some_and(|alias| alias.trim().eq_ignore_ascii_case(selector))
                    })
                    .collect()
            } else {
                by_id
            }
        }
    };
    match matches.as_slice() {
        [device] if device.online => Ok(ResolvedDispatchTarget::Device {
            device_id: device.device_id.clone(),
            display_name: device_label(device),
        }),
        [_] => bail!("Dispatch device {selector} is offline; no local fallback was attempted"),
        [] => bail!(
            "No other device on this account matches {selector}; list targets first and use a device name, device:<deviceId>, or ssh:<connectionId>"
        ),
        _ => bail!("Several account devices match {selector}; use device:<deviceId>"),
    }
}

fn device_json(device: &AccountDevice, local_device_id: Option<&str>) -> Value {
    json!({
        "deviceId": device.device_id,
        "name": device_label(device),
        "deviceName": device.device_name,
        "alias": device.device_alias,
        "kind": device.device_kind,
        "online": device.online,
        "isCurrentDevice": local_device_id == Some(device.device_id.as_str()),
        "model": device.device_model,
        "os": device.device_os,
        "osVersion": device.device_os_version,
        "compatible": device.compatible,
    })
}

impl DispatchControlContext<'_> {
    fn account(&self) -> anyhow::Result<&dyn DispatchAccountAccess> {
        self.account
            .ok_or_else(|| anyhow!("This host has no OpenBitFun account runtime"))
    }

    fn ssh(&self) -> anyhow::Result<&SSHConnectionManager> {
        self.ssh
            .as_ref()
            .map_err(|error| anyhow!("SSH dispatch is unavailable: {error}"))
    }

    /// Account devices other than this host.
    async fn other_devices(&self) -> anyhow::Result<Vec<AccountDevice>> {
        let local = self.local_device_id.as_deref();
        Ok(self
            .account()?
            .list_devices()
            .await?
            .into_iter()
            .filter(|device| local != Some(device.device_id.as_str()))
            .collect())
    }

    pub async fn resolve_target(&self, selector: &str) -> anyhow::Result<ResolvedDispatchTarget> {
        if selector.trim().starts_with("ssh:") {
            return resolve_dispatch_target(selector, &[]);
        }
        resolve_dispatch_target(selector, &self.other_devices().await?)
    }

    async fn job_targets_device(&self, job_id: &str) -> anyhow::Result<bool> {
        let record = self
            .store
            .get(job_id)
            .await?
            .ok_or_else(|| anyhow!("No dispatch job {job_id} was submitted from this host"))?;
        Ok(matches!(record.target, DispatchTarget::Device { .. }))
    }

    async fn list_targets(&self) -> Value {
        let local = self.local_device_id.as_deref();
        let mut result = json!({
            "submitTargetForms": ["<device name or alias>", "device:<deviceId>", "ssh:<connectionId>"],
        });
        match self.account() {
            Ok(account) => match account.list_devices().await {
                Ok(devices) => {
                    let others = devices
                        .iter()
                        .filter(|device| local != Some(device.device_id.as_str()));
                    result["signedIn"] = json!(true);
                    result["deviceCount"] = json!(devices.len());
                    result["otherOnlineDeviceCount"] =
                        json!(others.filter(|device| device.online).count());
                    result["devices"] = devices
                        .iter()
                        .map(|device| device_json(device, local))
                        .collect();
                }
                Err(error) => {
                    result["signedIn"] = json!(false);
                    result["devices"] = json!([]);
                    result["devicesUnavailable"] = json!(format!("{error:#}"));
                }
            },
            Err(error) => {
                result["signedIn"] = json!(false);
                result["devices"] = json!([]);
                result["devicesUnavailable"] = json!(error.to_string());
            }
        }
        match self.ssh() {
            Ok(ssh) => {
                match list_dispatch_targets(ssh, DispatchListTargetsRequest::default()).await {
                    Ok(targets) => {
                        result["sshTargets"] = targets
                        .into_iter()
                        .filter(|target| target.kind == "ssh")
                        .map(|target| {
                            json!({
                                "target": format!("ssh:{}", target.connection_id.clone().unwrap_or_default()),
                                "connectionId": target.connection_id,
                                "name": target.display_name,
                                "description": target.description,
                            })
                        })
                        .collect();
                    }
                    Err(error) => {
                        result["sshTargets"] = json!([]);
                        result["sshUnavailable"] = json!(format!("{error:#}"));
                    }
                }
            }
            Err(error) => {
                result["sshTargets"] = json!([]);
                result["sshUnavailable"] = json!(error.to_string());
            }
        }
        result
    }
}

/// Execute one Agent-facing dispatch-control request on this host.
pub async fn execute_dispatch_control(
    context: &DispatchControlContext<'_>,
    request: DetachedDispatchControlRequest,
) -> anyhow::Result<Value> {
    match request {
        DetachedDispatchControlRequest::ListTargets => Ok(context.list_targets().await),
        DetachedDispatchControlRequest::Submit {
            target,
            prompt,
            approval_policy,
            workspace_path,
            agent,
            model,
            base_ref,
            include_uncommitted,
            title,
        } => {
            if prompt.trim().is_empty() {
                bail!("Dispatch prompt cannot be empty");
            }
            if prompt.len() > MAX_DETACHED_DISPATCH_PROMPT_BYTES {
                bail!("Dispatch prompt exceeds the 32 KiB request limit");
            }
            let workspace = std::path::Path::new(workspace_path.trim());
            if !workspace.is_absolute() {
                bail!("workspacePath must be an absolute path on this host");
            }
            let workspace = workspace
                .canonicalize()
                .map_err(|error| anyhow!("resolve workspacePath: {error}"))?;
            let source_workspace_path = workspace
                .to_str()
                .ok_or_else(|| anyhow!("workspacePath is not valid UTF-8"))?
                .to_string();
            let resolved = context.resolve_target(&target).await?;
            let request = DispatchSubmitRequest {
                target: resolved.request(),
                base_ref: Some(base_ref.unwrap_or_else(|| "HEAD".to_string())),
                include_uncommitted,
                job_id: uuid::Uuid::new_v4().to_string(),
                session_id: uuid::Uuid::new_v4().to_string(),
                agent_type: openbitfun_core_types::agent_identity::canonical_agent_id(
                    agent.as_deref().unwrap_or("Standard"),
                )
                .to_string(),
                prompt,
                approval_policy: approval_policy.wire().to_string(),
                model,
                reasoning_preset: None,
                title,
                source_workspace_path: Some(source_workspace_path),
                source_workspace_id: None,
                attachments: Vec::new(),
            };
            let job_id = request.job_id.clone();
            let session_id = request.session_id.clone();
            let ack = match &resolved {
                ResolvedDispatchTarget::Device { display_name, .. } => {
                    let rpc = context.account()?.device_rpc();
                    submit_device_dispatch(
                        rpc.as_ref(),
                        context.store,
                        display_name.clone(),
                        request,
                    )
                    .await?
                }
                ResolvedDispatchTarget::Ssh { .. } => {
                    submit_dispatch(context.ssh()?, context.store, request).await?
                }
            };
            let target = match &resolved {
                ResolvedDispatchTarget::Device {
                    device_id,
                    display_name,
                } => json!({"kind":"device", "deviceId": device_id, "name": display_name}),
                ResolvedDispatchTarget::Ssh { connection_id } => {
                    json!({"kind":"ssh", "connectionId": connection_id})
                }
            };
            Ok(json!({
                "jobId": job_id,
                "sessionId": session_id,
                "target": target,
                "acknowledgement": ack,
                "nextStep": "Use status with this jobId to follow progress; the target keeps running if this host disconnects.",
            }))
        }
        DetachedDispatchControlRequest::Status { job_id, cursor } => {
            let request = DispatchStatusRequest { job_id, cursor };
            if context.job_targets_device(&request.job_id).await? {
                let rpc = context.account()?.device_rpc();
                get_device_dispatch_status(rpc.as_ref(), context.store, request).await
            } else {
                get_dispatch_status(context.ssh()?, context.store, request).await
            }
        }
        DetachedDispatchControlRequest::Cancel { job_id } => {
            let request = DispatchJobRequest { job_id };
            if context.job_targets_device(&request.job_id).await? {
                let rpc = context.account()?.device_rpc();
                cancel_device_dispatch(rpc.as_ref(), context.store, request).await
            } else {
                cancel_dispatch(context.ssh()?, context.store, request).await
            }
        }
        DetachedDispatchControlRequest::ListJobs { target } => {
            let Some(target) = target else {
                // The local outbound index needs no transport.
                return Ok(serde_json::to_value(context.store.list().await?)?);
            };
            let resolved = context.resolve_target(&target).await?;
            let request = DispatchListJobsRequest {
                target: Some(resolved.request()),
            };
            match resolved {
                ResolvedDispatchTarget::Device { display_name, .. } => {
                    let rpc = context.account()?.device_rpc();
                    list_device_dispatch_jobs(rpc.as_ref(), context.store, display_name, request)
                        .await
                }
                ResolvedDispatchTarget::Ssh { .. } => {
                    list_dispatch_jobs(context.ssh()?, context.store, request).await
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device(id: &str, name: &str, alias: Option<&str>, online: bool) -> AccountDevice {
        AccountDevice {
            device_id: id.to_string(),
            device_name: name.to_string(),
            device_kind: Some("cli".to_string()),
            device_alias: alias.map(str::to_string),
            device_model: None,
            device_os: None,
            device_os_version: None,
            device_client_version: None,
            device_client_protocol: None,
            compatible: None,
            online,
        }
    }

    #[test]
    fn target_selector_resolves_ids_names_aliases_and_ssh() {
        let devices = vec![
            device("mac-id", "MacBook-Pro-2.local", Some("Office Mac"), true),
            device("ecs-id", "ecs-box", None, true),
            device("old-id", "old-laptop", None, false),
        ];
        let expected = ResolvedDispatchTarget::Device {
            device_id: "mac-id".to_string(),
            display_name: "Office Mac".to_string(),
        };
        for selector in [
            "device:mac-id",
            "mac-id",
            "macbook-pro-2.local",
            "office mac",
        ] {
            assert_eq!(
                resolve_dispatch_target(selector, &devices).unwrap(),
                expected
            );
        }
        assert_eq!(
            resolve_dispatch_target("ssh:a100", &devices).unwrap(),
            ResolvedDispatchTarget::Ssh {
                connection_id: "a100".to_string()
            }
        );
        let offline = resolve_dispatch_target("old-laptop", &devices).unwrap_err();
        assert!(offline.to_string().contains("offline"), "{offline}");
        assert!(resolve_dispatch_target("missing", &devices).is_err());
        assert!(resolve_dispatch_target("ssh:", &devices).is_err());
        let duplicate = vec![
            device("a", "build", None, true),
            device("b", "build", None, true),
        ];
        let error = resolve_dispatch_target("build", &duplicate).unwrap_err();
        assert!(error.to_string().contains("device:<deviceId>"), "{error}");
    }

    struct FixedDevices(Vec<AccountDevice>);

    struct NoRpc;
    #[async_trait]
    impl DeviceDispatchRpc for NoRpc {
        async fn invoke(&self, _: &str, _: &str, _: Value) -> anyhow::Result<Value> {
            bail!("no transport in this test")
        }
    }

    #[async_trait]
    impl DispatchAccountAccess for FixedDevices {
        async fn list_devices(&self) -> anyhow::Result<Vec<AccountDevice>> {
            Ok(self.0.clone())
        }
        fn device_rpc(&self) -> Arc<dyn DeviceDispatchRpc> {
            Arc::new(NoRpc)
        }
    }

    #[tokio::test]
    async fn list_targets_counts_every_device_and_marks_this_host() {
        let dir = tempfile::tempdir().unwrap();
        let path_manager =
            crate::infrastructure::PathManager::with_user_root_for_tests(dir.path().to_path_buf());
        let store = OutboundDispatchStore::new(&path_manager);
        let account = FixedDevices(vec![
            device("self-id", "ecs-openbitfun-personal-lwb", None, true),
            device("mac-id", "MacBook-Pro-2.local", None, true),
        ]);
        let context = DispatchControlContext {
            store: &store,
            ssh: Err("not configured in this test".to_string()),
            account: Some(&account),
            local_device_id: Some("self-id".to_string()),
        };
        let result =
            execute_dispatch_control(&context, DetachedDispatchControlRequest::ListTargets)
                .await
                .unwrap();
        assert_eq!(result["deviceCount"], 2);
        assert_eq!(result["otherOnlineDeviceCount"], 1);
        assert_eq!(result["devices"][0]["isCurrentDevice"], true);
        assert_eq!(result["devices"][1]["isCurrentDevice"], false);
        assert!(result["sshUnavailable"].is_string());

        // A host never resolves itself as a dispatch target.
        assert!(context
            .resolve_target("ecs-openbitfun-personal-lwb")
            .await
            .is_err());
        assert!(context.resolve_target("MacBook-Pro-2.local").await.is_ok());

        let unknown = execute_dispatch_control(
            &context,
            DetachedDispatchControlRequest::Status {
                job_id: "missing".to_string(),
                cursor: 0,
            },
        )
        .await
        .unwrap_err();
        assert!(unknown.to_string().contains("No dispatch job"), "{unknown}");
    }

    #[tokio::test]
    async fn signed_out_hosts_report_why_devices_are_missing() {
        let dir = tempfile::tempdir().unwrap();
        let path_manager =
            crate::infrastructure::PathManager::with_user_root_for_tests(dir.path().to_path_buf());
        let store = OutboundDispatchStore::new(&path_manager);
        let context = DispatchControlContext {
            store: &store,
            ssh: Err("not configured".to_string()),
            account: None,
            local_device_id: None,
        };
        let result =
            execute_dispatch_control(&context, DetachedDispatchControlRequest::ListTargets)
                .await
                .unwrap();
        assert_eq!(result["signedIn"], false);
        assert!(result["devicesUnavailable"].is_string());
    }
}
