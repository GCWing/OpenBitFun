//! Controller side of Detached Dispatch for the CLI.
//!
//! `openbitfun dispatch outbound ...` submits jobs to another OpenBitFun host and
//! observes them. The existing `openbitfun dispatch <verb>` commands are the
//! target protocol and stay untouched. This module and the CLI's Agent
//! product-control provider both run the Core dispatch-control executor; they
//! only supply this host's account session and SSH manager.

use std::sync::Arc;

use anyhow::{anyhow, bail, Context, Result};
use clap::{Subcommand, ValueEnum};
use openbitfun_core::infrastructure::try_get_path_manager_arc;
use openbitfun_core::service::dispatch::{
    execute_dispatch_control, AccountRuntimeDispatchAccess, DispatchControlContext,
    OutboundDispatchStore,
};
use openbitfun_core::service::remote_connect::account_runtime::AccountRuntime;
use openbitfun_core::service::remote_connect::DeviceIdentity;
use openbitfun_product_domains::detached_dispatch_control::{
    DetachedDispatchApprovalPolicy, DetachedDispatchControlRequest,
    MAX_DETACHED_DISPATCH_PROMPT_BYTES,
};
use serde_json::Value;

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

impl From<OutboundApprovalPolicy> for DetachedDispatchApprovalPolicy {
    fn from(policy: OutboundApprovalPolicy) -> Self {
        match policy {
            OutboundApprovalPolicy::Auto => Self::Auto,
            OutboundApprovalPolicy::RejectAndReport => Self::RejectAndReport,
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
    let request = match action {
        OutboundAction::Targets => DetachedDispatchControlRequest::ListTargets,
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
            let workspace = match workspace {
                Some(path) => path,
                None => std::env::current_dir().context("resolve current directory")?,
            };
            let workspace = std::path::absolute(&workspace)
                .with_context(|| format!("resolve workspace {}", workspace.display()))?;
            DetachedDispatchControlRequest::Submit {
                target,
                prompt: resolve_prompt(prompt)?,
                approval_policy: approval_policy.into(),
                workspace_path: workspace
                    .to_str()
                    .ok_or_else(|| anyhow!("workspace path is not valid UTF-8"))?
                    .to_string(),
                agent: Some(agent),
                model,
                base_ref: Some(base_ref),
                include_uncommitted,
                title,
            }
        }
        OutboundAction::Status { job_id, cursor } => {
            DetachedDispatchControlRequest::Status { job_id, cursor }
        }
        OutboundAction::List { target } => DetachedDispatchControlRequest::ListJobs { target },
        OutboundAction::Cancel { job_id } => DetachedDispatchControlRequest::Cancel { job_id },
    };
    let account = crate::account::build_management_account_runtime();
    account.try_restore_session().await;
    execute_for_host(account, request).await
}

/// Run one dispatch-control request with this host's account and SSH manager.
pub(crate) async fn execute_for_host(
    account: Arc<AccountRuntime>,
    request: DetachedDispatchControlRequest,
) -> Result<Value> {
    let path_manager = try_get_path_manager_arc().context("resolve OpenBitFun data directory")?;
    let store = OutboundDispatchStore::new(path_manager.as_ref());
    let access = AccountRuntimeDispatchAccess::new(account);
    let ssh = match openbitfun_core::service::remote_ssh::workspace_state::ensure_saved_connection_services().await
    {
        Ok(state) => state
            .get_ssh_manager()
            .await
            .ok_or_else(|| "SSH manager is unavailable".to_string()),
        Err(error) => Err(error),
    };
    let context = DispatchControlContext {
        store: &store,
        ssh,
        account: Some(&access),
        local_device_id: DeviceIdentity::from_current_machine()
            .map(|identity| identity.device_id)
            .ok(),
    };
    execute_dispatch_control(&context, request).await
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
                .take(MAX_DETACHED_DISPATCH_PROMPT_BYTES as u64 + 1)
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
