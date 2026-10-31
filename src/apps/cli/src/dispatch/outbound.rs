//! Controller side of Detached Dispatch for the CLI.
//!
//! `openbitfun dispatch outbound ...` submits jobs to another OpenBitFun host and
//! observes them. The existing `openbitfun dispatch <verb>` commands are the
//! target protocol and stay untouched. The controller semantics (baseline,
//! provisioning, observer records) live in the Core dispatch owner; this module
//! only resolves the CLI's SSH and account-device transports and prints JSON.

use std::sync::Arc;

use anyhow::{anyhow, bail, Context, Result};
use clap::{Subcommand, ValueEnum};
use openbitfun_core::infrastructure::try_get_path_manager_arc;
use openbitfun_core::service::dispatch::{
    cancel_device_dispatch, cancel_dispatch, get_device_dispatch_status, get_dispatch_status,
    list_device_dispatch_jobs, list_dispatch_jobs, list_dispatch_targets, submit_device_dispatch,
    submit_dispatch, AccountRuntimeDeviceDispatchRpc, DispatchJobRequest, DispatchListJobsRequest,
    DispatchListTargetsRequest, DispatchStatusRequest, DispatchSubmitRequest, DispatchTarget,
    DispatchTargetOption, DispatchTargetRequest, OutboundDispatchStore,
};
use openbitfun_core::service::remote_connect::account_runtime::{AccountDevice, AccountRuntime};
use openbitfun_core::service::remote_connect::DeviceIdentity;
use openbitfun_core::service::remote_ssh::SSHConnectionManager;
use serde_json::Value;

const MAX_OUTBOUND_PROMPT_BYTES: u64 = 32 * 1024;

#[derive(Subcommand, Debug)]
pub(crate) enum OutboundAction {
    /// List SSH connections and online account devices this machine can dispatch to
    Targets,
    /// Submit a detached job to another host and print its acknowledgement
    ///
    /// The job runs in a worktree on the target, branched from the current Git
    /// checkout. This machine may disconnect after submission.
    Submit {
        /// Target: an account device name, `device:<deviceId>`, or `ssh:<connectionId>`
        #[arg(long)]
        target: String,
        /// How the target answers tool permission prompts while unattended
        #[arg(long, value_enum)]
        approval_policy: OutboundApprovalPolicy,
        /// Task prompt. If omitted, stdin is used when piped.
        prompt: Option<String>,
        /// Agent type on the target
        #[arg(short, long, default_value = "Standard")]
        agent: String,
        /// Model id on the target; defaults to the target's own default model
        #[arg(long)]
        model: Option<String>,
        /// Revision the target worktree starts from
        #[arg(long, default_value = "HEAD")]
        base_ref: String,
        /// Carry this checkout's uncommitted changes to the target
        #[arg(long)]
        include_uncommitted: bool,
        /// Short job title shown in job lists
        #[arg(long)]
        title: Option<String>,
        /// Git checkout to dispatch from; defaults to the current directory
        #[arg(long)]
        workspace: Option<std::path::PathBuf>,
    },
    /// Read a job's state and events after a cursor
    Status {
        job_id: String,
        /// Event cursor returned by a previous status call
        #[arg(long, default_value_t = 0)]
        cursor: u64,
    },
    /// List jobs submitted from this machine, or the jobs a target owns
    List {
        /// Target to ask directly (same forms as `submit --target`)
        #[arg(long)]
        target: Option<String>,
    },
    /// Cancel a submitted job
    Cancel { job_id: String },
}

#[derive(Clone, Copy, Debug, ValueEnum)]
pub(crate) enum OutboundApprovalPolicy {
    /// Approve every tool request that static rules do not deny
    Auto,
    /// Reject permission prompts and report them in the job result
    RejectAndReport,
}

impl OutboundApprovalPolicy {
    fn wire(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::RejectAndReport => "reject-and-report",
        }
    }
}

pub(crate) async fn run(action: OutboundAction) -> Result<()> {
    let result = run_action(action).await;
    match result {
        Ok(value) => {
            println!("{}", serde_json::to_string_pretty(&value)?);
            Ok(())
        }
        Err(error) => {
            println!(
                "{}",
                serde_json::to_string_pretty(
                    &serde_json::json!({ "error": format!("{error:#}") })
                )?
            );
            Err(error)
        }
    }
}

async fn run_action(action: OutboundAction) -> Result<Value> {
    openbitfun_core::service::config::initialize_global_config()
        .await
        .context("initialize global config")?;
    let path_manager = try_get_path_manager_arc().context("resolve OpenBitFun data directory")?;
    let store = OutboundDispatchStore::new(path_manager.as_ref());
    let context = OutboundContext::default();

    match action {
        OutboundAction::Targets => {
            let mut targets = list_dispatch_targets(
                &context.ssh_manager().await?,
                DispatchListTargetsRequest::default(),
            )
            .await?;
            targets.retain(|target| target.kind != "local");
            match context.account_devices().await {
                Ok(devices) => {
                    targets.extend(devices.into_iter().map(|device| DispatchTargetOption {
                        kind: "device".to_string(),
                        connection_id: None,
                        display_name: device_label(&device),
                        device_id: Some(device.device_id),
                        description: None,
                        online: Some(device.online),
                    }))
                }
                Err(error) => {
                    tracing::warn!("Account devices are unavailable for dispatch: {error:#}")
                }
            }
            Ok(serde_json::to_value(targets)?)
        }
        OutboundAction::Submit {
            target,
            approval_policy,
            prompt,
            agent,
            model,
            base_ref,
            include_uncommitted,
            title,
            workspace,
        } => {
            let prompt = resolve_prompt(prompt)?;
            let workspace = match workspace {
                Some(path) => path,
                None => std::env::current_dir().context("resolve current directory")?,
            };
            let workspace = workspace
                .canonicalize()
                .with_context(|| format!("resolve workspace {}", workspace.display()))?;
            let source_workspace_path = workspace
                .to_str()
                .ok_or_else(|| anyhow!("workspace path is not valid UTF-8"))?
                .to_string();
            let resolved = context.resolve_target(&target).await?;
            let request = DispatchSubmitRequest {
                target: resolved.request(),
                base_ref: Some(base_ref),
                include_uncommitted,
                job_id: uuid::Uuid::new_v4().to_string(),
                session_id: uuid::Uuid::new_v4().to_string(),
                agent_type: openbitfun_core_types::agent_identity::canonical_agent_id(&agent)
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
            match resolved {
                ResolvedTarget::Device { display_name, .. } => {
                    let rpc = context.device_rpc().await?;
                    submit_device_dispatch(&rpc, &store, display_name, request).await
                }
                ResolvedTarget::Ssh { .. } => {
                    submit_dispatch(&context.ssh_manager().await?, &store, request).await
                }
            }
        }
        OutboundAction::Status { job_id, cursor } => {
            let request = DispatchStatusRequest { job_id, cursor };
            if job_targets_device(&store, &request.job_id).await? {
                get_device_dispatch_status(&context.device_rpc().await?, &store, request).await
            } else {
                get_dispatch_status(&context.ssh_manager().await?, &store, request).await
            }
        }
        OutboundAction::Cancel { job_id } => {
            let request = DispatchJobRequest { job_id };
            if job_targets_device(&store, &request.job_id).await? {
                cancel_device_dispatch(&context.device_rpc().await?, &store, request).await
            } else {
                cancel_dispatch(&context.ssh_manager().await?, &store, request).await
            }
        }
        OutboundAction::List { target } => {
            let Some(target) = target else {
                return list_dispatch_jobs(
                    &context.ssh_manager().await?,
                    &store,
                    DispatchListJobsRequest { target: None },
                )
                .await;
            };
            let resolved = context.resolve_target(&target).await?;
            let request = DispatchListJobsRequest {
                target: Some(resolved.request()),
            };
            match resolved {
                ResolvedTarget::Device { display_name, .. } => {
                    let rpc = context.device_rpc().await?;
                    list_device_dispatch_jobs(&rpc, &store, display_name, request).await
                }
                ResolvedTarget::Ssh { .. } => {
                    list_dispatch_jobs(&context.ssh_manager().await?, &store, request).await
                }
            }
        }
    }
}

async fn job_targets_device(store: &OutboundDispatchStore, job_id: &str) -> Result<bool> {
    let record = store
        .get(job_id)
        .await?
        .ok_or_else(|| anyhow!("No outbound dispatch job {job_id} was submitted from here"))?;
    Ok(matches!(record.target, DispatchTarget::Device { .. }))
}

fn resolve_prompt(prompt: Option<String>) -> Result<String> {
    use std::io::{IsTerminal, Read};
    let prompt = match prompt {
        Some(prompt) => prompt,
        None => {
            let stdin = std::io::stdin();
            if stdin.is_terminal() {
                bail!("Provide a prompt argument or pipe it on stdin");
            }
            let mut raw = String::new();
            stdin
                .take(MAX_OUTBOUND_PROMPT_BYTES + 1)
                .read_to_string(&mut raw)
                .context("read dispatch prompt from stdin")?;
            raw
        }
    };
    if prompt.trim().is_empty() {
        bail!("Dispatch prompt cannot be empty");
    }
    Ok(prompt)
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ResolvedTarget {
    Device {
        device_id: String,
        display_name: String,
    },
    Ssh {
        connection_id: String,
    },
}

impl ResolvedTarget {
    fn request(&self) -> DispatchTargetRequest {
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

fn device_label(device: &AccountDevice) -> String {
    device
        .device_alias
        .as_deref()
        .map(str::trim)
        .filter(|alias| !alias.is_empty())
        .unwrap_or(&device.device_name)
        .to_string()
}

/// Resolve a `device:<id>` selector or a device name/alias among the account's
/// other devices. Names must match exactly one device.
fn resolve_device_selector(selector: &str, devices: &[AccountDevice]) -> Result<ResolvedTarget> {
    let selector = selector.trim();
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
        [device] if device.online => Ok(ResolvedTarget::Device {
            device_id: device.device_id.clone(),
            display_name: device_label(device),
        }),
        [_] => bail!("Dispatch device {selector} is offline; no local fallback was attempted"),
        [] => bail!(
            "No other device on this account matches {selector}; run `dispatch outbound targets`"
        ),
        _ => bail!("Several account devices match {selector}; use device:<deviceId>"),
    }
}

#[derive(Default)]
struct OutboundContext {
    account: tokio::sync::OnceCell<Arc<AccountRuntime>>,
}

impl OutboundContext {
    async fn ssh_manager(&self) -> Result<SSHConnectionManager> {
        let state =
            openbitfun_core::service::remote_ssh::workspace_state::ensure_saved_connection_services()
                .await
                .map_err(|error| anyhow!("SSH services are unavailable: {error}"))?;
        state
            .get_ssh_manager()
            .await
            .ok_or_else(|| anyhow!("SSH manager is unavailable"))
    }

    async fn account(&self) -> Result<Arc<AccountRuntime>> {
        let account = self
            .account
            .get_or_init(|| async {
                let account = crate::account::build_management_account_runtime();
                account.try_restore_session().await;
                account
            })
            .await
            .clone();
        if !account.is_logged_in().await {
            bail!("This machine is not signed in to an account; device dispatch is unavailable");
        }
        Ok(account)
    }

    async fn device_rpc(&self) -> Result<AccountRuntimeDeviceDispatchRpc> {
        Ok(AccountRuntimeDeviceDispatchRpc::new(self.account().await?))
    }

    /// Account devices other than this machine.
    async fn account_devices(&self) -> Result<Vec<AccountDevice>> {
        let devices = self.account().await?.list_devices().await?;
        let local_device_id = DeviceIdentity::from_current_machine()
            .map(|identity| identity.device_id)
            .ok();
        Ok(devices
            .into_iter()
            .filter(|device| local_device_id.as_deref() != Some(device.device_id.as_str()))
            .collect())
    }

    async fn resolve_target(&self, selector: &str) -> Result<ResolvedTarget> {
        if let Some(connection_id) = selector.trim().strip_prefix("ssh:") {
            let connection_id = connection_id.trim();
            if connection_id.is_empty() {
                bail!("ssh: targets need a saved connection id");
            }
            return Ok(ResolvedTarget::Ssh {
                connection_id: connection_id.to_string(),
            });
        }
        resolve_device_selector(selector, &self.account_devices().await?)
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
    fn device_selector_resolves_ids_names_and_aliases() {
        let devices = vec![
            device("mac-id", "MacBook-Pro-2.local", Some("Office Mac"), true),
            device("ecs-id", "ecs-box", None, true),
            device("old-id", "old-laptop", None, false),
        ];
        let expected = ResolvedTarget::Device {
            device_id: "mac-id".to_string(),
            display_name: "Office Mac".to_string(),
        };
        assert_eq!(
            resolve_device_selector("device:mac-id", &devices).unwrap(),
            expected
        );
        assert_eq!(
            resolve_device_selector("mac-id", &devices).unwrap(),
            expected
        );
        assert_eq!(
            resolve_device_selector("macbook-pro-2.local", &devices).unwrap(),
            expected
        );
        assert_eq!(
            resolve_device_selector("office mac", &devices).unwrap(),
            expected
        );

        let offline = resolve_device_selector("old-laptop", &devices).unwrap_err();
        assert!(offline.to_string().contains("offline"), "{offline}");
        assert!(resolve_device_selector("missing", &devices).is_err());
    }

    #[test]
    fn device_selector_rejects_ambiguous_names() {
        let devices = vec![
            device("a", "build", None, true),
            device("b", "build", None, true),
        ];
        let error = resolve_device_selector("build", &devices).unwrap_err();
        assert!(error.to_string().contains("device:<deviceId>"), "{error}");
    }
}
