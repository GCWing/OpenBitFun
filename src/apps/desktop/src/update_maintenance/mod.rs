//! Desktop-owned maintenance for bytes already verified by the official updater.
//!
//! Discovery, download and signature verification stay in tauri-plugin-updater.
//! These adapters own OS publication, authorization and the installer handoff.
use std::path::Path;
use tauri::AppHandle;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(any(target_os = "macos", target_os = "linux", test))]
mod publication;
#[cfg(windows)]
mod windows;

pub(crate) fn install(
    app: &AppHandle,
    bytes: &[u8],
    version: &str,
    kind: &str,
    receipt: &Path,
) -> Result<(), String> {
    let _ = (app, version, kind, receipt);
    #[cfg(windows)]
    return windows::install(app, bytes, version, receipt).map_err(|error| error.to_string());
    #[cfg(target_os = "macos")]
    return macos::install(bytes).map_err(|error| error.to_string());
    #[cfg(target_os = "linux")]
    return linux::install(app, bytes, kind).map_err(|error| error.to_string());
    #[allow(unreachable_code, unused_variables)]
    Err("Application maintenance is unsupported on this platform".into())
}
