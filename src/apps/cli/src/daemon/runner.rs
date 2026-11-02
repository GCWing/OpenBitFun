//! Headless daemon main loop.
//!
//! The daemon is a full Peer Device Mode host without the TUI: it initializes
//! the same core services as the interactive CLI, restores the persisted
//! account session, and holds the relay device-routing connection so this
//! device stays reachable whenever the machine is up.

use std::time::Duration;

use anyhow::{anyhow, Result};

use openbitfun_core::service::remote_connect::DeviceIdentity;

use crate::{runtime, BootstrapProfile};

use super::pid;

/// Run the daemon in the foreground until signalled to stop, or until the
/// relay rejects the account token (logout / token revoked elsewhere).
pub(crate) async fn run_daemon() -> Result<()> {
    if pid::is_daemon_running() {
        return Err(anyhow!(
            "another openbitfun daemon is already running (see `openbitfun daemon status`)"
        ));
    }

    let management = super::control::Server::reserve().await?;
    let _management_owner = management.owner_lease();

    // The daemon is not bound to the caller's cwd; peer commands carry their
    // own workspace paths. Home is a stable root for the runtime context.
    let workspace_root = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    let runtime = crate::initialize_core_services(
        &workspace_root,
        runtime::approval::CliApprovalPolicy::Ask,
        BootstrapProfile::Interactive,
    )
    .await?;

    let account = runtime.account_runtime();
    let Some(user_id) = account.try_restore_session().await else {
        return Err(anyhow!(
            "not logged in; run `openbitfun`, log in with `/login`, then start the daemon again"
        ));
    };
    tracing::info!("Daemon restored account session for user {user_id}");

    let device =
        DeviceIdentity::from_current_machine().map_err(|e| anyhow!("detect device: {e}"))?;
    let remote = crate::remote_control::activate_daemon(&runtime).await?;
    if let Err(error) = account.restore_device_routing(&device.device_name).await {
        tracing::warn!("Initial daemon Relay connection failed; will retry: {error}");
    }

    // Continuous account settings sync (30s pull + debounced push) so this
    // always-on host converges with cloud changes made on other devices and
    // attached controllers see fresh config without reconnecting.

    pid::write_pid_file()?;
    tracing::info!("openbitfun daemon running (pid {})", std::process::id());

    let mut management_task = tokio::spawn(management.run(remote.clone()));
    let relay_owner = remote.clone();
    let reconnect_task = tokio::spawn(async move {
        let mut retry = tokio::time::interval(Duration::from_secs(5));
        retry.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            retry.tick().await;
            if let Err(error) = relay_owner.reconcile_relay().await {
                tracing::warn!("Daemon Relay reconnect failed: {error}");
            }
        }
    });
    let mut exit_error = None;
    let mut expired_check = tokio::time::interval(Duration::from_secs(5));
    expired_check.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            result = &mut management_task => {
                tracing::error!("Daemon management server stopped: {result:?}");
                exit_error = Some(anyhow!("Daemon management server stopped unexpectedly"));
                break;
            }
            _ = remote.wait_for_shutdown_request() => {
                tracing::info!("Daemon management shutdown requested");
                break;
            }
            _ = shutdown_signal() => {
                tracing::info!("Daemon shutdown signal received");
                break;
            }
            _ = expired_check.tick() => {
                if account.is_token_expired() {
                    // Exit 0 on purpose: re-authentication needs a human, so
                    // Restart=on-failure must not loop the daemon.
                    tracing::warn!("Account token rejected by the relay; daemon exiting");
                    break;
                }
            }
        }
    }

    reconnect_task.abort();
    management_task.abort();
    remote.shutdown().await;
    runtime.account_routing().stop_device_routing().await;
    pid::remove_pid_file();
    crate::shutdown_mcp_servers().await;
    tracing::info!("openbitfun daemon stopped");
    match exit_error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

#[cfg(unix)]
async fn shutdown_signal() {
    use tokio::signal::unix::{signal, SignalKind};
    match (
        signal(SignalKind::terminate()),
        signal(SignalKind::interrupt()),
    ) {
        (Ok(mut sigterm), Ok(mut sigint)) => {
            tokio::select! {
                _ = sigterm.recv() => {}
                _ = sigint.recv() => {}
            }
        }
        _ => {
            tracing::warn!(
                "Failed to install signal handlers; daemon can only stop on token expiry"
            );
            std::future::pending::<()>().await;
        }
    }
}

#[cfg(not(unix))]
async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}
