//! CLI composition only. Native behavior and resources live in Services.
use super::BootstrapProfile;
use openbitfun_core::agentic::tools::computer_use_host::ComputerUseHostRef;
use std::sync::Arc;

fn profile_allows_gui(profile: BootstrapProfile) -> bool {
    matches!(
        profile,
        BootstrapProfile::Interactive | BootstrapProfile::Execution
    )
}

pub(crate) fn provider(profile: BootstrapProfile) -> Option<ComputerUseHostRef> {
    if !profile_allows_gui(profile) {
        return None;
    }
    // No OS prompts, application launch or implicit grants during bootstrap.
    // Permission requests remain an explicit user action.
    if let Err(reason) = openbitfun_computer_use::host_runtime::initialize() {
        tracing::info!(%reason, "Native Computer Use provider unavailable");
        return None;
    }
    if let Ok(paths) = openbitfun_core::infrastructure::try_get_path_manager_arc() {
        openbitfun_computer_use::set_ocr_debug_directory(
            paths
                .default_assistant_workspace_dir(None)
                .join(openbitfun_core_types::product_identity::hidden_data_directory())
                .join("computer_use_debug"),
        );
    }
    Some(Arc::new(
        openbitfun_computer_use::NativeComputerUseHost::new(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn detached_jobs_require_a_negotiated_provider_and_management_has_no_gui() {
        assert!(!profile_allows_gui(BootstrapProfile::Detached));
        assert!(!profile_allows_gui(BootstrapProfile::Management));
        assert!(profile_allows_gui(BootstrapProfile::Interactive));
        assert!(profile_allows_gui(BootstrapProfile::Execution));
    }
}

#[derive(clap::Subcommand)]
pub(crate) enum Action {
    /// Report configuration, graphical-session availability and OS permissions as JSON
    Status,
    /// Enable the shared ai.computer_use_enabled setting (OS consent is separate)
    Enable,
    /// Disable the shared ai.computer_use_enabled setting
    Disable,
    /// Explicitly request one OS permission on this machine
    RequestPermission {
        #[arg(value_enum)]
        kind: PermissionKind,
    },
}

#[derive(Clone, Copy, clap::ValueEnum)]
pub(crate) enum PermissionKind {
    Accessibility,
    ScreenRecording,
    InputPosting,
    InputMonitoring,
}

pub(crate) async fn run(action: Action) -> anyhow::Result<()> {
    use openbitfun_agent_tools::computer_use_permissions::ComputerPermissionKind as Kind;
    use openbitfun_core::service::config;
    config::initialize_global_config().await?;
    let config = config::get_global_config_service().await?;
    match action {
        Action::Enable | Action::Disable => {
            let enabled = matches!(action, Action::Enable);
            config
                .set_config("ai.computer_use_enabled", enabled)
                .await?;
            println!("{}", serde_json::json!({"computer_use_enabled": enabled}));
        }
        Action::Status => {
            let available = openbitfun_computer_use::host_runtime::availability();
            // Without a graphical session the OS permission probe cannot improve
            // availability and must not connect to another user's session bus.
            let permissions = if available.is_ok() {
                Some(openbitfun_computer_use::permissions::status().await)
            } else {
                None
            };
            let enabled: bool = config.get_config(Some("ai.computer_use_enabled")).await?;
            println!(
                "{}",
                serde_json::json!({
                    "computer_use_enabled": enabled,
                    "provider_available": available.is_ok(),
                    "unavailable_reason": available.err(),
                    "permissions": permissions,
                })
            );
        }
        Action::RequestPermission { kind } => {
            openbitfun_computer_use::host_runtime::initialize().map_err(anyhow::Error::msg)?;
            let kind = match kind {
                PermissionKind::Accessibility => Kind::Accessibility,
                PermissionKind::ScreenRecording => Kind::ScreenRecording,
                PermissionKind::InputPosting => Kind::InputPosting,
                PermissionKind::InputMonitoring => Kind::InputMonitoring,
            };
            let receipt = openbitfun_computer_use::permissions::request(kind)
                .await
                .map_err(anyhow::Error::msg)?;
            println!("{}", serde_json::to_string(&receipt)?);
        }
    }
    Ok(())
}
