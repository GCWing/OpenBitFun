//! Always-on CLI daemon: keeps this device reachable for account peers by
//! holding the relay device-routing connection in a headless process.
//!
//! The daemon is the single device-routing owner on this machine: interactive
//! CLI processes detect it via the pid file and skip their own relay
//! connection (same-machine processes share one `device_id`; last
//! AuthConnect wins). `install`/`uninstall` register it with the platform
//! service manager (systemd user unit / LaunchAgent) so it survives reboots.

pub(crate) mod control;
mod pid;
mod provision;
mod runner;
mod service;

pub(crate) use pid::{is_daemon_running, request_daemon_shutdown};
pub(crate) use provision::{deprovision, print_identity, provision};
pub(crate) use runner::run_daemon;
pub(crate) use service::{install_service, print_status, uninstall_service};
