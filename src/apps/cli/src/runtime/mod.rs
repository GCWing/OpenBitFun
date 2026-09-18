use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use openbitfun_agent_runtime::sdk::{AgentEventSource, AgentRuntime};
use openbitfun_core::agentic::system::AgenticSystem;
use openbitfun_core::product_assembly::{
    ProductAssemblyPlan, ProductServiceCapabilityAvailability,
};
use openbitfun_core::product_runtime::{
    build_local_runtime_services, ensure_product_dialog_scheduler, CoreAgentRuntimeCompatibility,
    CoreLocalWorkspaceSnapshot, CoreProductAgentRuntime, CoreProductEventQueueOwner,
};
use openbitfun_core::runtime_ports::PluginRuntimeAvailability;
use openbitfun_core::service::remote_connect::account_runtime::AccountRuntime;
use openbitfun_core::service::token_usage::TokenUsageService;
use openbitfun_runtime_ports::LocalWorkspaceSnapshotPort;
use openbitfun_runtime_services::RuntimeServices;

use crate::account::{build_account_runtime, CliAccountRoutingHost};
use crate::product_assembly::{assemble_acp_runtime_parts, assemble_cli_runtime_parts};

pub(crate) mod approval;

use approval::CliApprovalPolicy;

const RUNTIME_EVENT_BUFFER: usize = 256;

#[derive(Debug, Clone)]
pub(crate) struct CliProductRuntimeState {
    plan: ProductAssemblyPlan,
    service_availability: Vec<ProductServiceCapabilityAvailability>,
    plugin_runtime: PluginRuntimeAvailability,
}

impl CliProductRuntimeState {
    pub(crate) fn plan(&self) -> &ProductAssemblyPlan {
        &self.plan
    }

    pub(crate) fn service_availability(&self) -> &[ProductServiceCapabilityAvailability] {
        &self.service_availability
    }

    pub(crate) const fn plugin_runtime(&self) -> PluginRuntimeAvailability {
        self.plugin_runtime
    }
}

#[derive(Clone)]
pub(crate) struct CliRuntimeContext {
    workspace: openbitfun_core::service::workspace::WorkspaceInfo,
    workspace_root: PathBuf,
    agent_runtime: AgentRuntime,
    local_workspace_snapshot: Arc<dyn LocalWorkspaceSnapshotPort>,
    compatibility: CoreAgentRuntimeCompatibility,
    account_runtime: Arc<AccountRuntime>,
    account_routing: Arc<CliAccountRoutingHost>,
    token_usage_service: Arc<TokenUsageService>,
    _agent_event_queue_owner: CoreProductEventQueueOwner,
    services: RuntimeServices,
    product: CliProductRuntimeState,
    approval_policy: CliApprovalPolicy,
}

impl CliRuntimeContext {
    pub(crate) fn build(
        agentic_system: AgenticSystem,
        workspace: openbitfun_core::service::workspace::WorkspaceInfo,
        approval_policy: CliApprovalPolicy,
    ) -> Result<Self> {
        let scheduler = ensure_product_dialog_scheduler(&agentic_system);
        let (workspace_root, services) =
            build_local_runtime_services(&workspace.root_path, RUNTIME_EVENT_BUFFER)?;
        let parts = assemble_cli_runtime_parts(services)
            .context("Failed to assemble CLI product runtime")?;

        let product = CliProductRuntimeState {
            plan: parts.plan().clone(),
            service_availability: parts.service_availability().to_vec(),
            plugin_runtime: parts.plugin_runtime().availability(),
        };
        let (services, _disabled_plugin_runtime) = parts.into_runtime_parts();
        let agent_event_queue_owner =
            CoreProductEventQueueOwner::new(agentic_system.event_queue.clone());
        let agent_runtime = CoreProductAgentRuntime::build_with_event_source(
            agentic_system.coordinator.clone(),
            scheduler.clone(),
            agentic_system.token_usage_service.clone(),
            agent_event_queue_owner.runtime_source(),
            services.clone(),
        )
        .map_err(anyhow::Error::msg)
        .context("Failed to build CLI Agent Runtime SDK")?;
        let compatibility =
            CoreAgentRuntimeCompatibility::build(agentic_system.coordinator.clone(), scheduler);
        let account = build_account_runtime();
        openbitfun_core::product_runtime::account_pages::register_account_pages(&account.runtime);
        let local_workspace_snapshot = CoreLocalWorkspaceSnapshot::build();
        let token_usage_service = agentic_system.token_usage_service.clone();

        Ok(Self {
            workspace,
            workspace_root,
            _agent_event_queue_owner: agent_event_queue_owner,
            agent_runtime,
            local_workspace_snapshot,
            compatibility,
            account_runtime: account.runtime,
            account_routing: account.routing,
            token_usage_service,
            services,
            product,
            approval_policy,
        })
    }

    pub(crate) fn workspace(&self) -> &openbitfun_core::service::workspace::WorkspaceInfo {
        &self.workspace
    }

    pub(crate) fn workspace_root(&self) -> &Path {
        &self.workspace_root
    }

    pub(crate) fn agent_runtime(&self) -> &AgentRuntime {
        &self.agent_runtime
    }

    pub(crate) fn agent_event_source(&self) -> AgentEventSource {
        self._agent_event_queue_owner.runtime_source()
    }

    pub(crate) fn compatibility(&self) -> &CoreAgentRuntimeCompatibility {
        &self.compatibility
    }

    pub(crate) fn account_runtime(&self) -> &Arc<AccountRuntime> {
        &self.account_runtime
    }

    pub(crate) fn account_routing(&self) -> &Arc<CliAccountRoutingHost> {
        &self.account_routing
    }

    pub(crate) fn token_usage_service(&self) -> &Arc<TokenUsageService> {
        &self.token_usage_service
    }

    pub(crate) fn local_workspace_snapshot(&self) -> &Arc<dyn LocalWorkspaceSnapshotPort> {
        &self.local_workspace_snapshot
    }

    pub(crate) fn services(&self) -> &RuntimeServices {
        &self.services
    }

    pub(crate) fn product(&self) -> &CliProductRuntimeState {
        &self.product
    }

    pub(crate) const fn approval_policy(&self) -> CliApprovalPolicy {
        self.approval_policy
    }
}

#[derive(Clone)]
pub(crate) struct AcpRuntimeContext {
    agent_runtime: AgentRuntime,
    compatibility: CoreAgentRuntimeCompatibility,
    _agent_event_queue_owner: CoreProductEventQueueOwner,
}

impl AcpRuntimeContext {
    pub(crate) fn build(
        agentic_system: AgenticSystem,
        workspace_root: impl AsRef<Path>,
    ) -> Result<Self> {
        let scheduler = ensure_product_dialog_scheduler(&agentic_system);
        let (_, services) = build_local_runtime_services(workspace_root, RUNTIME_EVENT_BUFFER)?;
        let parts = assemble_acp_runtime_parts(services)
            .context("Failed to assemble ACP product runtime")?;
        let (services, _disabled_plugin_runtime) = parts.into_runtime_parts();
        let agent_event_queue_owner =
            CoreProductEventQueueOwner::new(agentic_system.event_queue.clone());
        let agent_runtime = CoreProductAgentRuntime::build_acp(
            agentic_system.coordinator.clone(),
            scheduler.clone(),
            agent_event_queue_owner.runtime_source(),
            services,
        )
        .map_err(anyhow::Error::msg)
        .context("Failed to build ACP Agent Runtime SDK")?;
        let compatibility =
            CoreAgentRuntimeCompatibility::build(agentic_system.coordinator, scheduler);

        Ok(Self {
            agent_runtime,
            compatibility,
            _agent_event_queue_owner: agent_event_queue_owner,
        })
    }

    pub(crate) fn parts(&self) -> (AgentRuntime, CoreAgentRuntimeCompatibility) {
        (self.agent_runtime.clone(), self.compatibility.clone())
    }
}

/// Minimal runtime context for the `server` command's app-server host.
///
/// Reuses the CLI product runtime (`DeliveryProfile::Cli` + the reviewed CLI
/// assembly) so the stdio app server exposes the same agent-kernel
/// capabilities as the CLI, without importing ACP protocol semantics or the
/// TUI-facing `CliRuntimeContext` owners.
#[derive(Clone)]
pub(crate) struct AppServerRuntimeContext {
    agent_runtime: AgentRuntime,
    event_source: AgentEventSource,
    compatibility: CoreAgentRuntimeCompatibility,
    _agent_event_queue_owner: CoreProductEventQueueOwner,
}

impl AppServerRuntimeContext {
    pub(crate) fn build(
        agentic_system: AgenticSystem,
        workspace_root: impl AsRef<Path>,
    ) -> Result<Self> {
        let scheduler = ensure_product_dialog_scheduler(&agentic_system);
        let (_, services) = build_local_runtime_services(workspace_root, RUNTIME_EVENT_BUFFER)?;
        let parts = assemble_cli_runtime_parts(services)
            .context("Failed to assemble CLI product runtime")?;
        let (services, _disabled_plugin_runtime) = parts.into_runtime_parts();
        let agent_event_queue_owner =
            CoreProductEventQueueOwner::new(agentic_system.event_queue.clone());
        let agent_runtime = CoreProductAgentRuntime::build_with_event_source(
            agentic_system.coordinator.clone(),
            scheduler.clone(),
            agentic_system.token_usage_service.clone(),
            agent_event_queue_owner.runtime_source(),
            services,
        )
        .map_err(anyhow::Error::msg)
        .context("Failed to build App Server Agent Runtime SDK")?;
        let event_source = agent_event_queue_owner.runtime_source();
        let compatibility =
            CoreAgentRuntimeCompatibility::build(agentic_system.coordinator.clone(), scheduler);

        Ok(Self {
            agent_runtime,
            event_source,
            compatibility,
            _agent_event_queue_owner: agent_event_queue_owner,
        })
    }

    pub(crate) fn parts(
        &self,
    ) -> (
        AgentRuntime,
        AgentEventSource,
        CoreAgentRuntimeCompatibility,
    ) {
        (
            self.agent_runtime.clone(),
            self.event_source.clone(),
            self.compatibility.clone(),
        )
    }
}
