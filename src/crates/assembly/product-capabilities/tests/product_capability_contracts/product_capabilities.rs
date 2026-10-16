use openbitfun_product_capabilities::{
    agent_runtime_baseline_tool_plan, default_product_assembly_plan,
    default_product_capability_assembly, default_product_capability_registry,
    product_assembly_plan_for_profile, product_delivery_profile_entries, DeliveryProfile,
    ProductAssembler, ProductAssemblyError, ProductAssemblyInput, ProductCapabilityBuildError,
    ProductCapabilityId, ProductCapabilityPack, ProductCapabilityRegistry,
    ProductCoreDependencyMode, ProductFeatureGroup, ProductRuntimeAssembly,
    ProductServiceCapabilityRequirement, ProductServiceCapabilityStatus,
};
use openbitfun_runtime_ports::{
    PluginDispatchEnvelope, PluginResponseEnvelope, PluginRuntimeAvailability,
    PluginRuntimeBinding, PluginRuntimeClient, PluginRuntimeUnavailableReason, PortResult,
    RuntimeServiceCapability,
};
use openbitfun_runtime_services::test_support::FakeRuntimeServicesProvider;
use openbitfun_runtime_services::{
    RuntimeServiceMarkerPort, RuntimeServicesBuilder, RuntimeServicesProvider,
};
use std::sync::Arc;

struct AvailablePluginRuntimeClient;

#[test]
fn agent_runtime_baseline_tool_plan_requests_only_baseline_feature_owners() {
    let plan = agent_runtime_baseline_tool_plan();

    assert_eq!(
        plan.feature_groups()
            .iter()
            .map(|feature_group| feature_group.id())
            .collect::<Vec<_>>(),
        ["basic", "agent-control"]
    );
    assert_eq!(
        plan.tool_provider_group_plan()
            .iter()
            .map(|provider| provider.provider_id())
            .collect::<Vec<_>>(),
        ["core.basic", "core.agent", "core.session",]
    );
}

#[test]
fn every_agent_runtime_delivery_profile_includes_product_control_discovery() {
    for profile in [
        DeliveryProfile::ProductFull,
        DeliveryProfile::Desktop,
        DeliveryProfile::Cli,
        DeliveryProfile::Acp,
        DeliveryProfile::Sdk,
    ] {
        let plan = product_assembly_plan_for_profile(profile);
        let tool_plan = plan.tool_plan();
        assert!(
            tool_plan
                .tool_provider_group_plan()
                .iter()
                .flat_map(|provider| provider.tool_names())
                .any(|tool_name| *tool_name == "OpenBitFunControl"),
            "{} must expose OpenBitFunControl to its agents",
            profile.id()
        );
    }
}

#[async_trait::async_trait]
impl PluginRuntimeClient for AvailablePluginRuntimeClient {
    fn availability(&self) -> PluginRuntimeAvailability {
        PluginRuntimeAvailability::Available
    }

    async fn dispatch(
        &self,
        envelope: PluginDispatchEnvelope,
    ) -> PortResult<PluginResponseEnvelope> {
        Ok(PluginResponseEnvelope {
            envelope_version: envelope.envelope_version,
            request_event_id: envelope.event_id,
            project_domain_id: envelope.project_domain_id,
            workspace_id: envelope.workspace_id,
            adapter_id: "test-plugin-runtime".to_string(),
            plugin_id: Some(envelope.source.plugin_id),
            completed_at_ms: 0,
            effects: Vec::new(),
            diagnostics: Vec::new(),
            quarantine: None,
            plugin_statuses: Vec::new(),
            observed_epochs: envelope.epochs,
        })
    }
}

struct MisreportedPluginRuntimeClient;

#[async_trait::async_trait]
impl PluginRuntimeClient for MisreportedPluginRuntimeClient {
    fn availability(&self) -> PluginRuntimeAvailability {
        PluginRuntimeAvailability::ProjectionOnly {
            reason: PluginRuntimeUnavailableReason::NotBuilt,
        }
    }

    async fn dispatch(
        &self,
        envelope: PluginDispatchEnvelope,
    ) -> PortResult<PluginResponseEnvelope> {
        Ok(PluginResponseEnvelope {
            envelope_version: envelope.envelope_version,
            request_event_id: envelope.event_id,
            project_domain_id: envelope.project_domain_id,
            workspace_id: envelope.workspace_id,
            adapter_id: "test-plugin-runtime".to_string(),
            plugin_id: Some(envelope.source.plugin_id),
            completed_at_ms: 0,
            effects: Vec::new(),
            diagnostics: Vec::new(),
            quarantine: None,
            plugin_statuses: Vec::new(),
            observed_epochs: envelope.epochs,
        })
    }
}

#[test]
fn default_capability_registry_preserves_product_tool_provider_order() {
    let assembly = default_product_capability_assembly();
    let provider_ids = assembly
        .tool_provider_group_plan()
        .iter()
        .map(|group| group.provider_id())
        .collect::<Vec<_>>();

    assert_eq!(
        provider_ids,
        vec![
            "core.basic",
            "core.agent",
            "core.session",
            "core.git",
            "core.web",
            "core.mcp",
            "core.computer-use",
            "core.review",
            "core.miniapp",
            "core.pages",
            "core.creation",
            "core.canvas",
        ]
    );
}

#[test]
fn capability_packs_describe_service_and_tool_requirements() {
    let registry = default_product_capability_registry();

    let capability_ids = registry
        .capability_ids()
        .into_iter()
        .map(ProductCapabilityId::id)
        .collect::<Vec<_>>();
    assert_eq!(
        capability_ids,
        vec![
            "code-agent",
            "deep-review",
            "deep-research",
            "miniapp",
            "pages",
            "creation",
            "canvas",
            "voice-input"
        ]
    );

    let service_capabilities = registry.required_service_capabilities();
    assert!(service_capabilities.contains(&RuntimeServiceCapability::FileSystem));
    assert!(service_capabilities.contains(&RuntimeServiceCapability::Workspace));
    assert!(service_capabilities.contains(&RuntimeServiceCapability::Events));
}

#[test]
fn product_assembly_plan_keeps_full_capabilities_only_for_core_compatibility_profiles() {
    let full_capabilities = vec![
        "code-agent",
        "deep-review",
        "deep-research",
        "miniapp",
        "pages",
        "creation",
        "canvas",
    ];
    let full_tool_groups = vec![
        "core.basic",
        "core.agent",
        "core.session",
        "core.git",
        "core.web",
        "core.mcp",
        "core.computer-use",
        "core.review",
        "core.miniapp",
        "core.pages",
        "core.creation",
        "core.canvas",
    ];

    for profile in [DeliveryProfile::ProductFull, DeliveryProfile::Desktop] {
        let plan = product_assembly_plan_for_profile(profile);
        let mut expected_capabilities = full_capabilities.clone();
        expected_capabilities.push("voice-input");

        assert_eq!(plan.profile(), profile);
        assert_eq!(
            plan.capability_set()
                .ids()
                .iter()
                .map(|capability_id| capability_id.id())
                .collect::<Vec<_>>(),
            expected_capabilities,
            "{profile} must include the desktop voice-input capability"
        );
        assert_eq!(
            plan.capability_assembly()
                .tool_provider_group_plan()
                .iter()
                .map(|group| group.provider_id())
                .collect::<Vec<_>>(),
            full_tool_groups,
            "{profile} must preserve current tool provider groups"
        );
    }

    for profile in [DeliveryProfile::Acp, DeliveryProfile::Sdk] {
        let plan = product_assembly_plan_for_profile(profile);

        assert_eq!(plan.profile(), profile);
        assert_eq!(
            plan.capability_set()
                .ids()
                .iter()
                .map(|capability_id| capability_id.id())
                .collect::<Vec<_>>(),
            vec!["code-agent"],
            "{profile} must select only the headless CodeAgent capability"
        );
        assert_eq!(
            plan.capability_assembly()
                .tool_provider_group_plan()
                .iter()
                .map(|group| group.provider_id())
                .collect::<Vec<_>>(),
            vec![
                "core.basic",
                "core.agent",
                "core.session",
                "core.git",
                "core.web",
                "core.mcp",
                "core.computer-use",
            ],
            "{profile} must assemble only generic Agent Runtime tool groups"
        );
    }
}

#[test]
fn no_direct_core_profiles_do_not_select_product_full_runtime_capabilities() {
    for profile in [
        DeliveryProfile::Server,
        DeliveryProfile::Remote,
        DeliveryProfile::Web,
        DeliveryProfile::MobileWeb,
    ] {
        let plan = product_assembly_plan_for_profile(profile);

        assert_eq!(plan.profile(), profile);
        assert!(
            plan.capability_set().ids().is_empty(),
            "{profile} must not implicitly select product-full capabilities"
        );
        assert!(
            plan.capability_assembly().capability_ids().is_empty(),
            "{profile} must not build runtime capability packs"
        );
        assert!(
            plan.capability_assembly().service_requirements().is_empty(),
            "{profile} must not require product-full runtime services"
        );
        assert!(
            plan.feature_groups().is_empty(),
            "{profile} must not expose product-full feature groups"
        );
        assert!(
            plan.capability_assembly()
                .tool_provider_group_plan()
                .is_empty(),
            "{profile} must not materialize product-full tool groups"
        );
    }
}

#[test]
fn product_delivery_profile_matrix_documents_current_core_dependency_shape() {
    let entries = product_delivery_profile_entries()
        .iter()
        .map(|entry| (entry.profile(), entry.core_dependency_mode()))
        .collect::<Vec<_>>();
    let matrix_profiles = entries
        .iter()
        .map(|(profile, _)| *profile)
        .collect::<Vec<_>>();

    assert_eq!(
        entries,
        vec![
            (
                DeliveryProfile::ProductFull,
                ProductCoreDependencyMode::ProductFullCompatibility,
            ),
            (
                DeliveryProfile::Desktop,
                ProductCoreDependencyMode::ProductFullCompatibility,
            ),
            (
                DeliveryProfile::DataTools,
                ProductCoreDependencyMode::ExplicitCoreCapabilityClosure,
            ),
            (
                DeliveryProfile::Cli,
                ProductCoreDependencyMode::ExplicitCoreCapabilityClosure,
            ),
            (
                DeliveryProfile::Server,
                ProductCoreDependencyMode::NoDirectCoreDependency,
            ),
            (
                DeliveryProfile::Remote,
                ProductCoreDependencyMode::NoDirectCoreDependency,
            ),
            (
                DeliveryProfile::Acp,
                ProductCoreDependencyMode::ExplicitCoreCapabilityClosure,
            ),
            (
                DeliveryProfile::Web,
                ProductCoreDependencyMode::NoDirectCoreDependency,
            ),
            (
                DeliveryProfile::MobileWeb,
                ProductCoreDependencyMode::NoDirectCoreDependency,
            ),
            (
                DeliveryProfile::Sdk,
                ProductCoreDependencyMode::ExplicitCoreCapabilityClosure,
            ),
        ]
    );
    assert_eq!(
        matrix_profiles,
        DeliveryProfile::all_current_product_profiles(),
        "delivery profile matrix must cover every current product profile exactly once"
    );
}

#[test]
fn product_assembly_plan_follows_core_dependency_matrix() {
    for entry in product_delivery_profile_entries() {
        let plan = product_assembly_plan_for_profile(entry.profile());

        match entry.core_dependency_mode() {
            ProductCoreDependencyMode::ProductFullCompatibility
            | ProductCoreDependencyMode::ExplicitCoreCapabilityClosure => {
                if entry.profile() == DeliveryProfile::DataTools {
                    assert!(
                        plan.capability_set().ids().is_empty(),
                        "data-tools must not assemble Agent Runtime capabilities"
                    );
                    assert!(
                        plan.capability_assembly()
                            .tool_provider_group_plan()
                            .is_empty(),
                        "data-tools must not assemble runtime tool groups"
                    );
                    assert!(
                        plan.feature_groups().is_empty(),
                        "data-tools must not expose runtime feature groups"
                    );
                    continue;
                }
                assert!(
                    !plan.capability_set().ids().is_empty(),
                    "{} must retain runtime capabilities",
                    entry.profile()
                );
                assert!(
                    !plan
                        .capability_assembly()
                        .tool_provider_group_plan()
                        .is_empty(),
                    "{} must retain runtime tool groups",
                    entry.profile()
                );
                assert!(
                    !plan.feature_groups().is_empty(),
                    "{} must retain runtime feature groups",
                    entry.profile()
                );
            }
            ProductCoreDependencyMode::NoDirectCoreDependency => {
                assert!(
                    plan.capability_set().ids().is_empty(),
                    "{} must not materialize product-full capabilities",
                    entry.profile()
                );
                assert!(
                    plan.capability_assembly()
                        .tool_provider_group_plan()
                        .is_empty(),
                    "{} must not materialize product-full tool groups",
                    entry.profile()
                );
                assert!(
                    plan.feature_groups().is_empty(),
                    "{} must not expose product-full feature groups",
                    entry.profile()
                );
            }
            _ => panic!(
                "{} has an unsupported core dependency mode in the product assembly plan test",
                entry.profile()
            ),
        }
    }
}

#[test]
fn data_tools_profile_is_a_minimal_non_agent_product_plan() {
    let plan = product_assembly_plan_for_profile(DeliveryProfile::DataTools);

    assert_eq!(plan.profile().id(), "data-tools");
    assert!(plan.capability_set().ids().is_empty());
    assert!(plan.capability_assembly().agent_ids().is_empty());
    assert!(plan.capability_assembly().service_requirements().is_empty());
    assert!(plan.feature_groups().is_empty());
    assert!(plan
        .capability_assembly()
        .tool_provider_group_plan()
        .is_empty());
    assert_eq!(
        plan.extension_capabilities().plugin_runtime(),
        PluginRuntimeAvailability::disabled(PluginRuntimeUnavailableReason::UnsupportedProfile)
    );
}

#[test]
fn product_assembly_plan_keeps_plugin_runtime_disabled_until_explicit_client_binding() {
    for profile in DeliveryProfile::all_current_product_profiles() {
        let extension_capabilities = product_assembly_plan_for_profile(*profile)
            .extension_capabilities()
            .clone();

        assert!(
            !extension_capabilities.plugin_runtime().is_executable(),
            "{profile} must not imply executable plugin runtime support"
        );
    }
}

#[test]
fn product_assembly_plan_distinguishes_plugin_runtime_unavailable_reasons_by_profile() {
    assert_eq!(
        product_assembly_plan_for_profile(DeliveryProfile::Desktop)
            .extension_capabilities()
            .plugin_runtime(),
        PluginRuntimeAvailability::Disabled {
            reason: PluginRuntimeUnavailableReason::NotBuilt
        }
    );
    assert_eq!(
        product_assembly_plan_for_profile(DeliveryProfile::Web)
            .extension_capabilities()
            .plugin_runtime(),
        PluginRuntimeAvailability::Disabled {
            reason: PluginRuntimeUnavailableReason::UnsupportedProfile
        }
    );
}

#[test]
fn product_assembly_plan_exposes_build_feature_groups_explicitly() {
    let plan = product_assembly_plan_for_profile(DeliveryProfile::ProductFull);

    assert_eq!(
        plan.feature_groups(),
        &[
            ProductFeatureGroup::Basic,
            ProductFeatureGroup::ImageAnalysis,
            ProductFeatureGroup::AgentControl,
            ProductFeatureGroup::Git,
            ProductFeatureGroup::BrowserWeb,
            ProductFeatureGroup::Mcp,
            ProductFeatureGroup::ComputerUse,
            ProductFeatureGroup::MiniApp,
            ProductFeatureGroup::Pages,
            ProductFeatureGroup::Creation,
            ProductFeatureGroup::Canvas,
        ]
    );
    assert_eq!(
        plan.feature_group_ids(),
        vec![
            "basic",
            "image-analysis",
            "agent-control",
            "git",
            "browser-web",
            "mcp",
            "computer-use",
            "miniapp",
            "pages",
            "creation",
            "canvas",
        ]
    );
}

#[test]
fn product_assembly_plan_reports_service_availability_by_capability() {
    let plan = default_product_assembly_plan();

    let unavailable = plan
        .service_availability_report(|capability| {
            !matches!(
                capability,
                RuntimeServiceCapability::Git | RuntimeServiceCapability::Network
            )
        })
        .into_iter()
        .filter(|entry| entry.status() == ProductServiceCapabilityStatus::Unavailable)
        .collect::<Vec<_>>();

    assert_eq!(unavailable.len(), 5);
    assert_eq!(
        unavailable[0].requirement(),
        ProductServiceCapabilityRequirement::new(
            ProductCapabilityId::CodeAgent,
            RuntimeServiceCapability::Git,
        )
    );
    assert_eq!(
        unavailable[1].requirement(),
        ProductServiceCapabilityRequirement::new(
            ProductCapabilityId::CodeAgent,
            RuntimeServiceCapability::Network,
        )
    );
    assert_eq!(
        unavailable[2].requirement(),
        ProductServiceCapabilityRequirement::new(
            ProductCapabilityId::DeepReview,
            RuntimeServiceCapability::Git,
        )
    );
    assert_eq!(
        unavailable[3].requirement(),
        ProductServiceCapabilityRequirement::new(
            ProductCapabilityId::DeepResearch,
            RuntimeServiceCapability::Network,
        )
    );
}

#[test]
fn product_runtime_assembly_reports_runtime_service_capability_gaps() {
    let assembly = ProductRuntimeAssembly::product_full();
    let partial_services = FakeRuntimeServicesProvider::with_all_required()
        .build_services()
        .expect("required runtime services should build");

    assert_eq!(
        assembly.missing_service_requirements(&partial_services),
        vec![
            ProductServiceCapabilityRequirement::new(
                ProductCapabilityId::CodeAgent,
                RuntimeServiceCapability::Terminal,
            ),
            ProductServiceCapabilityRequirement::new(
                ProductCapabilityId::CodeAgent,
                RuntimeServiceCapability::Git,
            ),
            ProductServiceCapabilityRequirement::new(
                ProductCapabilityId::CodeAgent,
                RuntimeServiceCapability::Network,
            ),
            ProductServiceCapabilityRequirement::new(
                ProductCapabilityId::DeepReview,
                RuntimeServiceCapability::Git,
            ),
            ProductServiceCapabilityRequirement::new(
                ProductCapabilityId::DeepResearch,
                RuntimeServiceCapability::Network,
            ),
            ProductServiceCapabilityRequirement::new(
                ProductCapabilityId::Pages,
                RuntimeServiceCapability::Network,
            ),
        ]
    );

    let complete_services = FakeRuntimeServicesProvider::with_all_required()
        .register(RuntimeServicesBuilder::new())
        .with_optional_terminal(Some(FakeRuntimeServicesProvider::terminal_port()))
        .with_optional_git(Some(RuntimeServiceMarkerPort::git_port()))
        .with_optional_network(Some(RuntimeServiceMarkerPort::network_port()))
        .build()
        .expect("runtime services should satisfy product requirements");

    assert!(assembly
        .missing_service_requirements(&complete_services)
        .is_empty());
    assert_eq!(assembly.plan().profile(), DeliveryProfile::ProductFull);
}

#[test]
fn product_assembler_builds_runtime_parts_from_explicit_profile_input() {
    let services = FakeRuntimeServicesProvider::with_all_required()
        .register(RuntimeServicesBuilder::new())
        .with_optional_terminal(Some(FakeRuntimeServicesProvider::terminal_port()))
        .with_optional_git(Some(RuntimeServiceMarkerPort::git_port()))
        .with_optional_network(Some(RuntimeServiceMarkerPort::network_port()))
        .build()
        .expect("runtime services should satisfy product requirements");

    let parts = ProductAssembler::new()
        .assemble(ProductAssemblyInput::new(DeliveryProfile::Cli, services))
        .expect("complete service set should assemble product runtime parts");

    assert_eq!(parts.plan().profile(), DeliveryProfile::Cli);
    assert!(parts.missing_service_requirements().is_empty());
    assert!(parts
        .services()
        .has_capability(RuntimeServiceCapability::Terminal));
    assert_eq!(
        parts.plugin_runtime().availability(),
        PluginRuntimeAvailability::Disabled {
            reason: PluginRuntimeUnavailableReason::NotBuilt
        }
    );
}

#[test]
fn product_assembler_preserves_explicit_plugin_runtime_binding() {
    let services = FakeRuntimeServicesProvider::with_all_required()
        .register(RuntimeServicesBuilder::new())
        .with_optional_terminal(Some(FakeRuntimeServicesProvider::terminal_port()))
        .with_optional_git(Some(RuntimeServiceMarkerPort::git_port()))
        .with_optional_network(Some(RuntimeServiceMarkerPort::network_port()))
        .build()
        .expect("runtime services should satisfy product requirements");

    let parts = ProductAssembler::new()
        .assemble(
            ProductAssemblyInput::new(DeliveryProfile::Desktop, services).with_plugin_runtime(
                PluginRuntimeBinding::projection_only(
                    PluginRuntimeUnavailableReason::UnsupportedProfile,
                ),
            ),
        )
        .expect("explicit plugin runtime binding should be carried by runtime parts");

    assert_eq!(
        parts.plugin_runtime().availability(),
        PluginRuntimeAvailability::ProjectionOnly {
            reason: PluginRuntimeUnavailableReason::UnsupportedProfile
        }
    );
    assert_eq!(
        parts.plan().extension_capabilities().plugin_runtime(),
        PluginRuntimeAvailability::ProjectionOnly {
            reason: PluginRuntimeUnavailableReason::UnsupportedProfile
        }
    );
}

#[test]
fn product_assembler_rejects_executable_plugin_runtime_binding_for_non_p0_profile() {
    let services = FakeRuntimeServicesProvider::with_all_required()
        .register(RuntimeServicesBuilder::new())
        .with_optional_terminal(Some(FakeRuntimeServicesProvider::terminal_port()))
        .with_optional_git(Some(RuntimeServiceMarkerPort::git_port()))
        .with_optional_network(Some(RuntimeServiceMarkerPort::network_port()))
        .build()
        .expect("runtime services should satisfy product requirements");

    let error = ProductAssembler::new()
        .assemble(
            ProductAssemblyInput::new(DeliveryProfile::Acp, services).with_plugin_runtime(
                PluginRuntimeBinding::client(Arc::new(AvailablePluginRuntimeClient)),
            ),
        )
        .expect_err("ACP must not inherit an executable P0 plugin runtime client");

    assert_eq!(
        error,
        ProductAssemblyError::UnsupportedPluginRuntime {
            profile: DeliveryProfile::Acp,
            availability: PluginRuntimeAvailability::Available
        }
    );
}

#[test]
fn product_assembler_rejects_client_plugin_runtime_binding_even_when_reported_projection_only() {
    let services = FakeRuntimeServicesProvider::with_all_required()
        .register(RuntimeServicesBuilder::new())
        .with_optional_terminal(Some(FakeRuntimeServicesProvider::terminal_port()))
        .with_optional_git(Some(RuntimeServiceMarkerPort::git_port()))
        .with_optional_network(Some(RuntimeServiceMarkerPort::network_port()))
        .build()
        .expect("runtime services should satisfy product requirements");

    let error = ProductAssembler::new()
        .assemble(
            ProductAssemblyInput::new(DeliveryProfile::Desktop, services).with_plugin_runtime(
                PluginRuntimeBinding::client(Arc::new(MisreportedPluginRuntimeClient)),
            ),
        )
        .expect_err("client plugin runtime binding must wait for host-stage gates");

    assert_eq!(
        error,
        ProductAssemblyError::UnsupportedPluginRuntime {
            profile: DeliveryProfile::Desktop,
            availability: PluginRuntimeAvailability::ProjectionOnly {
                reason: PluginRuntimeUnavailableReason::NotBuilt
            }
        }
    );
}

#[test]
fn product_assembler_reports_missing_services_without_building_runtime_parts() {
    let services = FakeRuntimeServicesProvider::with_all_required()
        .build_services()
        .expect("required runtime services should build");

    let error = ProductAssembler::new()
        .assemble(ProductAssemblyInput::new(
            DeliveryProfile::Desktop,
            services,
        ))
        .expect_err("desktop product-full compatibility requires optional product services");

    assert_eq!(
        error,
        ProductAssemblyError::MissingRuntimeServices {
            profile: DeliveryProfile::Desktop,
            missing: vec![
                ProductServiceCapabilityRequirement::new(
                    ProductCapabilityId::CodeAgent,
                    RuntimeServiceCapability::Terminal,
                ),
                ProductServiceCapabilityRequirement::new(
                    ProductCapabilityId::CodeAgent,
                    RuntimeServiceCapability::Git,
                ),
                ProductServiceCapabilityRequirement::new(
                    ProductCapabilityId::CodeAgent,
                    RuntimeServiceCapability::Network,
                ),
                ProductServiceCapabilityRequirement::new(
                    ProductCapabilityId::DeepReview,
                    RuntimeServiceCapability::Git,
                ),
                ProductServiceCapabilityRequirement::new(
                    ProductCapabilityId::DeepResearch,
                    RuntimeServiceCapability::Network,
                ),
                ProductServiceCapabilityRequirement::new(
                    ProductCapabilityId::Pages,
                    RuntimeServiceCapability::Network,
                ),
            ],
        }
    );
}

#[test]
fn product_assembler_allows_no_direct_core_profiles_without_product_services() {
    for profile in [
        DeliveryProfile::Server,
        DeliveryProfile::Remote,
        DeliveryProfile::Web,
        DeliveryProfile::MobileWeb,
    ] {
        let services = FakeRuntimeServicesProvider::with_all_required()
            .build_services()
            .expect("baseline runtime services should build");

        let parts = ProductAssembler::new()
            .assemble(ProductAssemblyInput::new(profile, services))
            .expect("no-direct-core profile should not require product-full runtime services");

        assert_eq!(parts.plan().profile(), profile);
        assert!(parts.plan().capability_set().ids().is_empty());
        assert!(parts.service_availability().is_empty());
        assert!(parts.missing_service_requirements().is_empty());
    }
}

#[test]
fn default_capability_assembly_keeps_service_and_tool_facts_together() {
    let assembly = default_product_capability_assembly();

    let capability_ids = assembly
        .capability_ids()
        .iter()
        .map(|capability_id| capability_id.id())
        .collect::<Vec<_>>();
    assert_eq!(
        capability_ids,
        vec![
            "code-agent",
            "deep-review",
            "deep-research",
            "miniapp",
            "pages",
            "creation",
            "canvas",
            "voice-input"
        ]
    );

    let service_capabilities = assembly.required_service_capabilities();
    assert_eq!(
        service_capabilities,
        vec![
            RuntimeServiceCapability::FileSystem,
            RuntimeServiceCapability::Workspace,
            RuntimeServiceCapability::SessionStore,
            RuntimeServiceCapability::Events,
            RuntimeServiceCapability::Clock,
            RuntimeServiceCapability::Terminal,
            RuntimeServiceCapability::Git,
            RuntimeServiceCapability::Network,
        ]
    );

    let tool_provider_ids = assembly
        .tool_provider_group_plan()
        .iter()
        .map(|group| group.provider_id())
        .collect::<Vec<_>>();
    assert_eq!(
        tool_provider_ids,
        vec![
            "core.basic",
            "core.agent",
            "core.session",
            "core.git",
            "core.web",
            "core.mcp",
            "core.computer-use",
            "core.review",
            "core.miniapp",
            "core.pages",
            "core.creation",
            "core.canvas",
        ]
    );
}

#[test]
fn capability_assembly_reports_missing_services_without_concrete_runtime_dependency() {
    let assembly = default_product_capability_assembly();

    let missing = assembly.missing_service_requirements(|capability| {
        !matches!(
            capability,
            RuntimeServiceCapability::Git | RuntimeServiceCapability::Network
        )
    });

    assert_eq!(
        missing,
        vec![
            ProductServiceCapabilityRequirement::new(
                ProductCapabilityId::CodeAgent,
                RuntimeServiceCapability::Git,
            ),
            ProductServiceCapabilityRequirement::new(
                ProductCapabilityId::CodeAgent,
                RuntimeServiceCapability::Network,
            ),
            ProductServiceCapabilityRequirement::new(
                ProductCapabilityId::DeepReview,
                RuntimeServiceCapability::Git,
            ),
            ProductServiceCapabilityRequirement::new(
                ProductCapabilityId::DeepResearch,
                RuntimeServiceCapability::Network,
            ),
            ProductServiceCapabilityRequirement::new(
                ProductCapabilityId::Pages,
                RuntimeServiceCapability::Network,
            ),
        ]
    );

    assert!(
        assembly
            .missing_service_requirements(|_capability| true)
            .is_empty(),
        "fully assembled product runtime must report no service capability gaps"
    );
}

#[test]
fn capability_registry_rejects_unknown_tool_provider_groups() {
    static BROKEN_TOOL_GROUPS: &[&str] = &["core.missing"];
    static BROKEN_PACKS: &[ProductCapabilityPack] = &[ProductCapabilityPack::new(
        ProductCapabilityId::CodeAgent,
        &[],
        BROKEN_TOOL_GROUPS,
        &[],
    )];

    let registry = ProductCapabilityRegistry::new(BROKEN_PACKS);
    let error = registry
        .try_tool_provider_group_plan()
        .expect_err("unknown provider groups must not be silently dropped");

    assert_eq!(
        error,
        ProductCapabilityBuildError::UnknownToolProviderGroup {
            provider_id: "core.missing"
        }
    );
}
