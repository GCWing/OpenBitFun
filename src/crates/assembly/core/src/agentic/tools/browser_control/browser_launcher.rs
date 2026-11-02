//! Compatibility facade for browser CDP launch and detection.
//!
//! Platform browser detection and launch process handling live in
//! `openbitfun-services-integrations`. Core keeps this module to preserve the
//! existing product/tool import path and to inject OpenBitFun's managed profile
//! directory.

use openbitfun_services_integrations::browser_control::launcher as provider;
pub use provider::{
    BrowserDebugEndpoint, BrowserInfo, BrowserKind, BrowserLaunchOptions, LaunchResult,
    DEFAULT_CDP_PORT,
};
use std::path::PathBuf;

use crate::infrastructure::app_paths::get_path_manager_arc;
use crate::util::errors::OpenBitFunResult;

pub struct BrowserLauncher;

impl BrowserLauncher {
    pub async fn is_cdp_available(port: u16) -> bool {
        provider::BrowserLauncher::is_cdp_available(port).await
    }

    pub fn detect_default_browser() -> OpenBitFunResult<BrowserKind> {
        Ok(provider::BrowserLauncher::detect_default_browser()?)
    }

    pub fn is_browser_installed(kind: &BrowserKind) -> bool {
        provider::BrowserLauncher::is_browser_installed(kind)
    }

    #[cfg(test)]
    pub fn clear_install_cache() {
        provider::BrowserLauncher::clear_install_cache()
    }

    pub fn browser_kind_from_cdp_version(version_str: &str) -> Option<BrowserKind> {
        provider::BrowserLauncher::browser_kind_from_cdp_version(version_str)
    }

    pub fn browser_kind_from_config(value: &str) -> Option<BrowserKind> {
        provider::BrowserLauncher::browser_kind_from_config(value)
    }

    pub fn resolve_browser_kind(preferred_browser: Option<&str>) -> OpenBitFunResult<BrowserKind> {
        Ok(provider::BrowserLauncher::resolve_browser_kind(
            preferred_browser,
        )?)
    }

    pub fn browser_executable(kind: &BrowserKind) -> String {
        provider::BrowserLauncher::browser_executable(kind)
    }

    pub fn supports_default_cdp(kind: &BrowserKind) -> bool {
        provider::BrowserLauncher::supports_default_cdp(kind)
    }

    pub fn is_default_cdp_enabled(kind: &BrowserKind) -> bool {
        provider::BrowserLauncher::is_default_cdp_enabled(kind)
    }

    pub fn user_profile_debugging_setup_url(kind: &BrowserKind) -> Option<&'static str> {
        provider::BrowserLauncher::user_profile_debugging_setup_url(kind)
    }

    /// Browser-level endpoint published by a browser that is running right now
    /// with remote debugging enabled. `None` means there is nothing to attach
    /// to without going through the launch flow.
    pub fn user_profile_debug_endpoint(kind: &BrowserKind) -> Option<BrowserDebugEndpoint> {
        provider::BrowserLauncher::user_profile_debug_endpoint(kind)
    }

    pub async fn launch_with_cdp(kind: &BrowserKind, port: u16) -> OpenBitFunResult<LaunchResult> {
        Ok(provider::BrowserLauncher::launch_with_cdp_options(
            kind,
            port,
            Self::launch_options(None, false),
        )
        .await?)
    }

    pub async fn launch_with_cdp_opts(
        kind: &BrowserKind,
        port: u16,
        user_data_dir: Option<&str>,
    ) -> OpenBitFunResult<LaunchResult> {
        Ok(provider::BrowserLauncher::launch_with_cdp_options(
            kind,
            port,
            Self::launch_options(user_data_dir, false),
        )
        .await?)
    }

    /// Restarting the user's browser is an explicit, user-initiated action, so
    /// the relaunched browser is brought forward instead of staying hidden.
    pub async fn restart_with_cdp(kind: &BrowserKind, port: u16) -> OpenBitFunResult<LaunchResult> {
        Ok(provider::BrowserLauncher::launch_with_cdp_options(
            kind,
            port,
            Self::launch_options(None, true),
        )
        .await?)
    }

    /// Explicit Settings flow: keep the browser settings page open long enough
    /// for the user-owned consent toggle, then continue with the guarded
    /// real-profile connection as soon as the endpoint appears.
    pub async fn enable_default_cdp(
        kind: &BrowserKind,
        port: u16,
    ) -> OpenBitFunResult<LaunchResult> {
        let mut options = Self::launch_options(None, true);
        options.wait_for_user_profile_setup = true;
        Ok(provider::BrowserLauncher::launch_with_cdp_options(kind, port, options).await?)
    }

    /// Surface an already-running browser so the user can answer a
    /// browser-owned prompt. Returns whether the platform accepted the request.
    pub fn activate_browser(kind: &BrowserKind) -> bool {
        provider::BrowserLauncher::activate_browser(kind)
    }

    fn launch_options(user_data_dir: Option<&str>, activate: bool) -> BrowserLaunchOptions {
        BrowserLaunchOptions {
            user_data_dir: user_data_dir.map(PathBuf::from),
            managed_profile_root: Some(get_path_manager_arc().user_data_dir()),
            wait_for_user_profile_setup: false,
            activate,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::BrowserLauncher;
    use crate::infrastructure::app_paths::get_path_manager_arc;
    use std::path::PathBuf;

    #[test]
    fn launch_options_injects_openbitfun_managed_profile_root() {
        let options = BrowserLauncher::launch_options(None, false);

        assert_eq!(options.user_data_dir, None);
        assert_eq!(
            options.managed_profile_root,
            Some(get_path_manager_arc().user_data_dir())
        );
        assert!(!options.activate);
    }

    #[test]
    fn launch_options_preserves_explicit_user_data_dir() {
        let explicit_profile = "custom-browser-profile";
        let options = BrowserLauncher::launch_options(Some(explicit_profile), false);

        assert_eq!(options.user_data_dir, Some(PathBuf::from(explicit_profile)));
        assert_eq!(
            options.managed_profile_root,
            Some(get_path_manager_arc().user_data_dir())
        );
    }

    #[test]
    fn only_user_visible_launch_flows_activate_the_browser() {
        assert!(!BrowserLauncher::launch_options(None, false).activate);
        assert!(BrowserLauncher::launch_options(None, true).activate);
    }
}
