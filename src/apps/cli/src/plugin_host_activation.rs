use openbitfun_core::OpenBitFunResult;
use openbitfun_runtime_ports::AgentSessionWorkspaceBinding;

fn activation_target(binding: &AgentSessionWorkspaceBinding) -> Option<&str> {
    match binding.workspace_kind.as_ref()? {
        openbitfun_core::service::workspace::WorkspaceKind::Remote => None,
        _ => binding.workspace_id.as_deref(),
    }
}

pub(crate) async fn ensure_configured_plugin_execution_supported() -> OpenBitFunResult<bool> {
    // Plugin activation is optional. Isolated Runtime clients (including unit
    // tests) may create sessions before the process-level config service is
    // initialized; that must not make ordinary session creation fail.
    if !openbitfun_core::service::config::GlobalConfigManager::is_initialized() {
        return Ok(false);
    }

    let config_service = openbitfun_core::service::config::get_global_config_service().await?;
    let config: openbitfun_core::service::config::GlobalConfig =
        config_service.get_config(None).await?;
    // A plugin declaration is itself the user's explicit opt-in.  External
    // integration policy and activation approval are no longer prerequisites
    // for starting the configured Plugin Host; they remain independent
    // controls for other external-source features.
    Ok(config.has_configured_plugins())
}

pub(crate) async fn ensure_plugin_workspace_ready(
    binding: &AgentSessionWorkspaceBinding,
) -> OpenBitFunResult<()> {
    if let Err(error) = try_ensure_plugin_workspace_ready(binding).await {
        openbitfun_core::plugin_host::report_configured_plugin_activation_failure(
            "CLI workspace activation",
            binding.workspace_id.as_deref(),
            error,
        )
        .await;
    }
    Ok(())
}

async fn try_ensure_plugin_workspace_ready(
    binding: &AgentSessionWorkspaceBinding,
) -> OpenBitFunResult<()> {
    if !ensure_configured_plugin_execution_supported().await? {
        return Ok(());
    }

    let Some(target) = activation_target(binding) else {
        return Err(openbitfun_core::OpenBitFunError::NotImplemented(
            "Configured Plugin Host is unsupported for Remote CLI workspaces; no controller-local fallback was attempted"
                .to_string(),
        ));
    };

    openbitfun_core::plugin_host::ensure_configured_plugin_instance(
        crate::PLUGIN_HOST_LAUNCH_POLICY,
        target,
    )
    .await
    .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::activation_target;
    use openbitfun_runtime_ports::{AgentSessionWorkspaceBinding, SessionExecutionTarget};
    fn binding() -> AgentSessionWorkspaceBinding {
        AgentSessionWorkspaceBinding {
            workspace_kind: Some(openbitfun_core::service::workspace::WorkspaceKind::Normal),
            project_workspace_id: None,
            workspace_id: Some("workspace-1".to_string()),
            workspace_path: "C:/workspace/project".to_string(),
            project_workspace_path: Some("C:/workspace/project".to_string()),
            execution_target: Some(SessionExecutionTarget::local("C:/workspace/project")),
            remote_connection_id: None,
            remote_ssh_host: None,
        }
    }

    #[test]
    fn local_binding_maps_to_plugin_workspace_target() {
        assert_eq!(activation_target(&binding()), Some("workspace-1"));
    }

    #[test]
    fn remote_binding_skips_local_plugin_host() {
        let mut binding = binding();
        binding.workspace_kind = Some(openbitfun_core::service::workspace::WorkspaceKind::Remote);

        assert_eq!(activation_target(&binding), None);
    }

    #[test]
    fn local_kind_ignores_stale_ssh_fields() {
        let mut binding = binding();
        binding.remote_connection_id = Some("stale-ssh-id".into());
        assert_eq!(activation_target(&binding), Some("workspace-1"));
    }

    #[test]
    fn unresolved_binding_cannot_activate_plugins() {
        let mut binding = binding();
        binding.workspace_kind = None;
        assert_eq!(activation_target(&binding), None);
    }

    #[test]
    fn cli_enables_configured_plugin_execution_after_core_authorization() {
        assert_eq!(
            crate::PLUGIN_HOST_LAUNCH_POLICY,
            openbitfun_core::plugin_host::PluginHostLaunchPolicy::Enabled
        );
    }
}
