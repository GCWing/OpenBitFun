use anyhow::{Context, Result};

use openbitfun_core::product_assembly::DeliveryProfile;
use openbitfun_core::product_runtime::CoreRuntimeServicesProvider;
use openbitfun_core::runtime_ownership::CoreRuntimeOwnership;
use std::sync::Arc;

pub(crate) use openbitfun_core::agentic::system::AgenticSystem;

pub(crate) fn select_agentic_system_profile(profile: DeliveryProfile) -> Result<()> {
    openbitfun_core::agentic::system::select_agentic_system_profile(profile)
        .context("Failed to select agentic system delivery profile")
}

pub(crate) async fn init_agentic_system(
    profile: DeliveryProfile,
    runtime_ownership: Arc<CoreRuntimeOwnership>,
    computer_use_host: Option<
        openbitfun_core::agentic::tools::computer_use_host::ComputerUseHostRef,
    >,
) -> Result<AgenticSystem> {
    let system = openbitfun_core::agentic::system::init_agentic_system_with_computer_use_host(
        profile,
        runtime_ownership,
        computer_use_host,
    )
    .await
    .context("Failed to initialize agentic system")?;
    system
        .coordinator
        .set_terminal_port(CoreRuntimeServicesProvider::terminal_port());
    system
        .coordinator
        .set_remote_exec_port(CoreRuntimeServicesProvider::remote_exec_port());
    Ok(system)
}
