//! Core-owned product tool runtime owner.
//!
//! This module is the single core-side owner for assembling product tool
//! registry adapters, catalog manifests, GetToolSpec lookup, and snapshot
//! decoration. Concrete tools and `ToolUseContext` stay in core so this owner
//! remains an equivalent structural boundary rather than a behavior migration.

mod call_deferred_tool;
mod catalog;
mod get_tool_spec_tool;
mod loaded_spec_state;
mod materialization;
mod mcp_catalog;
mod snapshot;

use crate::agentic::tools::registry::{ProductToolDecoratorRef, ToolRegistry};
use materialization::{create_product_tool_registry_from_plan, ProductToolMaterializationError};
use openbitfun_agent_tools::SnapshotToolDecorator;
#[cfg(not(feature = "product-full"))]
use openbitfun_product_capabilities::agent_runtime_baseline_tool_plan;
use openbitfun_product_capabilities::{
    product_assembly_plan_for_profile, DeliveryProfile, ProductAssemblyPlan, ProductToolPlan,
};
use openbitfun_tool_packs::{ToolPackFeatureGroup, ToolProviderGroupPlan};
use snapshot::ProductSnapshotToolWrapper;
use std::sync::Arc;

pub use call_deferred_tool::CallDeferredTool;
pub use catalog::{build_all_tools_info, build_tool_info, ToolInfoDto};
pub(crate) use catalog::{
    product_get_tool_spec_runtime, resolve_product_get_tool_spec_results,
    resolve_product_readonly_enabled_tools, resolve_product_resolved_tool_manifest,
    resolve_product_resolved_visible_tools, ProductGetToolSpecRuntime, ProductToolCatalogProvider,
};
pub use catalog::{ResolvedToolManifest, ResolvedVisibleTools};
pub use get_tool_spec_tool::GetToolSpecTool;
pub(crate) use loaded_spec_state::collect_product_loaded_deferred_tool_specs;
pub use mcp_catalog::{build_chat_mcp_catalog, ChatMcpCatalog, ChatMcpCatalogRequest, ChatMcpTool};

#[derive(Clone)]
pub(crate) struct ProductToolRuntime {
    tool_decorator: ProductToolDecoratorRef,
    tool_provider_group_plan: Vec<ToolProviderGroupPlan>,
    requested_feature_groups: Vec<ToolPackFeatureGroup>,
}

impl Default for ProductToolRuntime {
    fn default() -> Self {
        Self::new()
    }
}

impl ProductToolRuntime {
    pub(crate) fn new() -> Self {
        #[cfg(feature = "product-full")]
        {
            Self::for_profile(DeliveryProfile::ProductFull)
        }
        #[cfg(not(feature = "product-full"))]
        {
            Self::agent_runtime_baseline()
        }
    }

    pub(crate) fn for_profile(profile: DeliveryProfile) -> Self {
        Self::with_tool_decorator_and_assembly_plan(
            Arc::new(SnapshotToolDecorator::new(Arc::new(
                ProductSnapshotToolWrapper,
            ))),
            product_assembly_plan_for_profile(profile),
        )
    }

    #[cfg(not(feature = "product-full"))]
    pub(crate) fn agent_runtime_baseline() -> Self {
        Self::with_tool_decorator_and_plan(
            Arc::new(SnapshotToolDecorator::new(Arc::new(
                ProductSnapshotToolWrapper,
            ))),
            agent_runtime_baseline_tool_plan(),
        )
    }

    pub(crate) fn with_tool_decorator(tool_decorator: ProductToolDecoratorRef) -> Self {
        #[cfg(feature = "product-full")]
        {
            Self::with_tool_decorator_and_assembly_plan(
                tool_decorator,
                product_assembly_plan_for_profile(DeliveryProfile::ProductFull),
            )
        }
        #[cfg(not(feature = "product-full"))]
        {
            Self::with_tool_decorator_and_plan(tool_decorator, agent_runtime_baseline_tool_plan())
        }
    }

    pub(crate) fn with_tool_decorator_and_assembly_plan(
        tool_decorator: ProductToolDecoratorRef,
        assembly_plan: ProductAssemblyPlan,
    ) -> Self {
        Self::with_tool_decorator_and_plan(tool_decorator, assembly_plan.tool_plan())
    }

    fn with_tool_decorator_and_plan(
        tool_decorator: ProductToolDecoratorRef,
        tool_plan: ProductToolPlan,
    ) -> Self {
        Self {
            tool_decorator,
            tool_provider_group_plan: tool_plan.tool_provider_group_plan().to_vec(),
            requested_feature_groups: tool_plan
                .feature_groups()
                .iter()
                .copied()
                .map(ToolPackFeatureGroup::from)
                .collect(),
        }
    }

    pub(crate) fn create_registry(&self) -> Result<ToolRegistry, ProductToolMaterializationError> {
        let inner = create_product_tool_registry_from_plan(
            &self.tool_provider_group_plan,
            &self.requested_feature_groups,
            self.tool_decorator.clone(),
        )?;
        Ok(ToolRegistry::from_inner(inner))
    }
}

#[cfg(all(test, feature = "product-full"))]
mod tests {
    use std::collections::BTreeSet;

    use super::ProductToolRuntime;
    use crate::agentic::tools::registry::create_tool_registry;
    use openbitfun_product_capabilities::{product_assembly_plan_for_profile, DeliveryProfile};

    #[test]
    fn product_tool_runtime_owner_preserves_registry_contract() {
        let runtime = ProductToolRuntime::default();
        let owner_registry = runtime
            .create_registry()
            .expect("product-full runtime plan must materialize");
        let compatibility_registry = create_tool_registry();

        assert_eq!(
            owner_registry.get_tool_names(),
            compatibility_registry.get_tool_names(),
            "product tool runtime owner must preserve legacy registry output"
        );
        assert_eq!(
            owner_registry.get_deferred_tool_names(),
            compatibility_registry.get_deferred_tool_names(),
            "product tool runtime owner must preserve deferred-tool exposure"
        );
    }

    #[test]
    fn product_tool_runtime_provider_plan_covers_registry_without_owning_order() {
        let assembly = product_assembly_plan_for_profile(DeliveryProfile::ProductFull)
            .capability_assembly()
            .clone();
        let planned_names = assembly
            .tool_provider_group_plan()
            .iter()
            .flat_map(|group| group.tool_names())
            .copied()
            .collect::<BTreeSet<_>>();
        let registry_names = create_tool_registry()
            .get_tool_names()
            .into_iter()
            .collect::<BTreeSet<_>>();

        assert_eq!(
            planned_names,
            registry_names
                .iter()
                .map(String::as_str)
                .collect::<BTreeSet<_>>()
        );
    }

    #[test]
    fn product_tool_runtime_can_consume_explicit_product_assembly_plan() {
        let runtime = ProductToolRuntime::for_profile(DeliveryProfile::Cli);
        let owner_registry = runtime
            .create_registry()
            .expect("CLI runtime plan must materialize in the product-full test build");
        let selected_names = product_assembly_plan_for_profile(DeliveryProfile::Cli)
            .capability_assembly()
            .tool_provider_group_plan()
            .iter()
            .flat_map(|group| group.tool_names())
            .copied()
            .collect::<BTreeSet<_>>();
        let expected_names = create_tool_registry()
            .get_tool_names()
            .into_iter()
            .filter(|tool_name| selected_names.contains(tool_name.as_str()))
            .collect::<Vec<_>>();

        assert_eq!(owner_registry.get_tool_names(), expected_names);
        assert!(owner_registry.get_tool("CodeReview").is_none());
        assert!(owner_registry.get_tool("CreateCanvas").is_none());
        assert!(owner_registry.get_tool("InitMiniApp").is_none());
    }

    #[test]
    fn product_tool_runtime_can_consume_acp_product_assembly_plan() {
        let runtime = ProductToolRuntime::for_profile(DeliveryProfile::Acp);
        let owner_registry = runtime
            .create_registry()
            .expect("ACP runtime plan must materialize in the product-full test build");
        let selected_names = product_assembly_plan_for_profile(DeliveryProfile::Acp)
            .capability_assembly()
            .tool_provider_group_plan()
            .iter()
            .flat_map(|group| group.tool_names())
            .copied()
            .collect::<BTreeSet<_>>();
        let expected_names = create_tool_registry()
            .get_tool_names()
            .into_iter()
            .filter(|tool_name| selected_names.contains(tool_name.as_str()))
            .collect::<Vec<_>>();

        assert_eq!(owner_registry.get_tool_names(), expected_names);
        assert!(owner_registry.get_tool("CodeReview").is_none());
        assert!(owner_registry.get_tool("CreateCanvas").is_none());
        assert!(owner_registry.get_tool("InitMiniApp").is_none());
    }

    #[test]
    fn sdk_and_cli_profiles_current_tool_plan_ceilings_match_without_sharing_identity() {
        let sdk = ProductToolRuntime::for_profile(DeliveryProfile::Sdk)
            .create_registry()
            .expect("SDK runtime plan must materialize in the product-full test build");
        let cli = ProductToolRuntime::for_profile(DeliveryProfile::Cli)
            .create_registry()
            .expect("CLI runtime plan must materialize in the product-full test build");

        assert_eq!(sdk.get_tool_names(), cli.get_tool_names());
        assert_eq!(sdk.get_deferred_tool_names(), cli.get_deferred_tool_names());
    }

    #[test]
    fn product_tool_runtime_keeps_no_direct_core_profiles_empty() {
        for profile in [
            DeliveryProfile::Server,
            DeliveryProfile::Remote,
            DeliveryProfile::Web,
            DeliveryProfile::MobileWeb,
        ] {
            let runtime = ProductToolRuntime::for_profile(profile);
            let registry = runtime
                .create_registry()
                .expect("empty no-direct-Core profile must materialize");

            assert!(
                registry.get_tool_names().is_empty(),
                "{profile} must not expose product-full tools"
            );
            assert!(
                registry.get_deferred_tool_names().is_empty(),
                "{profile} must not expose deferred product-full tools"
            );
        }
    }
}

#[cfg(all(test, not(feature = "product-full")))]
mod baseline_tests {
    use super::ProductToolRuntime;
    use openbitfun_product_capabilities::DeliveryProfile;

    #[test]
    fn agent_runtime_baseline_materializes_only_its_owned_tool_groups() {
        let registry = ProductToolRuntime::agent_runtime_baseline()
            .create_registry()
            .expect("agent-runtime guarantees its Basic and AgentControl owners");
        let names = registry.get_tool_names();

        for required in ["LS", "Read", "Task", "SessionControl", "Cron"] {
            assert!(
                names.iter().any(|name| name == required),
                "missing {required}"
            );
        }
        for excluded in [
            "view_image",
            "GetFileDiff",
            "CreateCanvas",
            "WebSearch",
            "ListMCPResources",
            "Worktree",
            "ComputerUse",
        ] {
            assert!(
                names.iter().all(|name| name != excluded),
                "baseline must not expose {excluded}"
            );
        }
    }

    #[test]
    fn unavailable_product_profile_returns_a_typed_materialization_error() {
        let error =
            match ProductToolRuntime::for_profile(DeliveryProfile::ProductFull).create_registry() {
                Ok(_) => panic!("a narrow binary must reject the ProductFull tool plan"),
                Err(error) => error,
            };

        assert!(error.to_string().contains("absent from this binary"));
    }
}
