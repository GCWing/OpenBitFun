//! Desktop Computer Use: portable admission/observation lifecycle, native OS providers.

mod ax_snapshot_digest;
pub mod control_session;
mod debug_overlay;
mod desktop_host;
mod displays;
pub mod grants;
mod interactive_filter;
#[cfg(target_os = "linux")]
mod linux_ax_ui;
#[cfg(target_os = "linux")]
mod linux_control;
#[cfg(target_os = "linux")]
mod linux_control_ax;
#[cfg(target_os = "linux")]
mod linux_native;
#[cfg(target_os = "macos")]
mod macos_ax_dispatch;
#[cfg(target_os = "macos")]
mod macos_ax_dump;
#[cfg(target_os = "macos")]
mod macos_ax_shortcuts;
#[cfg(target_os = "macos")]
mod macos_ax_ui;
#[cfg(target_os = "macos")]
mod macos_ax_write;
#[cfg(target_os = "macos")]
mod macos_bg_input;
#[cfg(target_os = "macos")]
mod macos_capture;
#[cfg(target_os = "macos")]
mod macos_input_focus;
#[cfg(target_os = "macos")]
mod macos_list_apps;
#[cfg(target_os = "macos")]
mod macos_skylight;
mod observation_cache;
mod ocr_context;
#[cfg(any(target_os = "macos", target_os = "windows", test))]
mod overlay_windows;
pub mod permissions;
pub(crate) mod process_identity;
#[cfg(any(target_os = "windows", test))]
mod provider_worker;
mod screen_ocr;
pub mod share_grants;
mod som_overlay;
mod terminal_detect;
mod ui_locate_common;
#[cfg(target_os = "windows")]
mod windows_ax_shortcuts;
#[cfg(target_os = "windows")]
mod windows_ax_ui;
#[cfg(target_os = "windows")]
mod windows_bg_input;
#[cfg(target_os = "windows")]
mod windows_capture;
#[cfg(target_os = "windows")]
mod windows_list_apps;
#[cfg(target_os = "windows")]
mod windows_msaa;
#[cfg(any(target_os = "windows", test))]
mod windows_overlay;
#[cfg(target_os = "windows")]
mod windows_pointer_feedback;
#[cfg(target_os = "windows")]
mod windows_wgc_capture;
#[cfg(any(target_os = "windows", test))]
mod windows_window_target;

pub use desktop_host::shared_preview;
pub use desktop_host::sharing::targets as share_targets;
pub use desktop_host::NativeComputerUseHost;

#[cfg(test)]
mod integration_e2e;

#[cfg(all(feature = "test-support", target_os = "macos"))]
pub mod test_support;
