//! Integration service owner crate.
//!
//! Heavy external integrations live here behind feature groups so local checks
//! can opt into only the integration family they need.

#[cfg(any(
    feature = "account-identity",
    feature = "mcp",
    feature = "miniapp-market",
    feature = "miniapp-runtime",
    feature = "models-dev",
    feature = "remote-connect",
    feature = "remote-ssh-concrete",
    feature = "review-platform",
    feature = "speech",
    feature = "web-tools",
))]
pub(crate) fn reqwest_client_builder() -> reqwest::ClientBuilder {
    openbitfun_services_core::tls_provider::ensure_ring_crypto_provider();
    reqwest::Client::builder()
}

#[cfg(any(
    feature = "announcement",
    feature = "browser-control",
    feature = "mcp",
    feature = "remote-connect",
))]
pub(crate) fn reqwest_client() -> reqwest::Client {
    openbitfun_services_core::tls_provider::ensure_ring_crypto_provider();
    reqwest::Client::new()
}

#[cfg(feature = "announcement")]
pub mod announcement;

#[cfg(feature = "miniapp-market")]
pub mod appearance_market;

#[cfg(feature = "browser-control")]
pub mod browser_control;

#[cfg(feature = "canvas-runtime")]
pub mod canvas;

#[cfg(feature = "deep-research")]
pub mod deep_research;

#[cfg(feature = "file-watch")]
pub mod file_watch;

#[cfg(feature = "function-agents")]
pub mod function_agents;

#[cfg(feature = "git")]
pub mod git;

#[cfg(feature = "hook-import")]
pub mod hook_import;

#[cfg(feature = "mcp")]
pub mod mcp;

#[cfg(feature = "models-dev")]
pub mod models_dev;

#[cfg(any(feature = "miniapp-runtime", feature = "miniapp-storage"))]
pub mod miniapp;

#[cfg(all(feature = "miniapp-loopx", not(feature = "miniapp-runtime")))]
pub mod miniapp;

#[cfg(feature = "miniapp-market")]
pub mod miniapp_market;

#[cfg(feature = "miniapp-market")]
pub mod market_image;

#[cfg(feature = "plugin-source")]
pub mod plugin_source;

#[cfg(any(feature = "git", feature = "review-platform"))]
mod repository_trust;

#[cfg(feature = "remote-connect")]
pub mod remote_connect;

#[cfg(feature = "remote-persistence")]
pub mod remote_persistence;

#[cfg(all(test, feature = "remote-connect"))]
mod feature_contract_tests {
    #[test]
    fn remote_connect_feature_exposes_its_public_module() {
        let _ = super::remote_connect::RemoteConnectSubmissionSource::Relay;
    }
}

#[cfg(feature = "remote-ssh")]
pub mod remote_ssh;

#[cfg(feature = "review-platform")]
pub mod review_platform;

#[cfg(feature = "review-platform")]
pub(crate) mod review_platform_http;

#[cfg(feature = "script-tool-runtime")]
pub mod script_tool;
#[cfg(feature = "speech")]
pub mod speech;

#[cfg(feature = "workspace-search")]
pub mod workspace_search;

#[cfg(feature = "web-tools")]
pub mod web_tools;

#[cfg(all(windows, feature = "git"))]
#[link(name = "advapi32")]
unsafe extern "system" {}

#[cfg(feature = "account-identity")]
pub mod account_identity;
