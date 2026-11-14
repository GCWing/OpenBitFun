mod ai_config;
pub(super) mod commands;
#[cfg(windows)]
mod elevation;
mod extract;
mod generated_locale_contract;
mod transaction;
mod types;

/// Windows main binary file name — must match `src/apps/desktop` `[[bin]]` and Tauri NSIS output.
const MAIN_APP_EXE: &str = "openbitfun-desktop.exe";

#[cfg(target_os = "windows")]
mod registry;
#[cfg(target_os = "windows")]
mod shortcut;
