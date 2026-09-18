//! Product capability pack contracts.
//!
//! This crate owns provider-neutral product capability assembly facts. Concrete
//! workflow execution and tool implementations remain in their runtime owners.

use std::collections::HashSet;
use std::fmt;

use openbitfun_runtime_ports::{
    PluginRuntimeAvailability, PluginRuntimeBinding, PluginRuntimeUnavailableReason,
    RuntimeServiceCapability,
};
use openbitfun_runtime_services::RuntimeServices;
pub use openbitfun_tool_packs::ToolProviderGroupPlanSelectionError as ProductCapabilityBuildError;
use openbitfun_tool_packs::{
    try_product_tool_provider_group_plan_for_ids, ToolPackFeatureGroup, ToolProviderGroupPlan,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum ProductCapabilityId {
    CodeAgent,
    DeepReview,
    DeepResearch,
    MiniApp,
    Pages,
    Creation,
    Canvas,
    VoiceInput,
}

impl ProductCapabilityId {
    pub const fn id(self) -> &'static str {
        match self {
            Self::CodeAgent => "code-agent",
            Self::DeepReview => "deep-review",
            Self::DeepResearch => "deep-research",
            Self::MiniApp => "miniapp",
            Self::Pages => "pages",
            Self::Creation => "creation",
            Self::Canvas => "canvas",
            Self::VoiceInput => "voice-input",
        }
    }
}

impl fmt::Display for ProductCapabilityId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.id())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[non_exhaustive]
pub enum ProductFeatureGroup {
    Basic,
    Git,
    Mcp,
    BrowserWeb,
    ComputerUse,
    ImageAnalysis,
    MiniApp,
    Pages,
    Creation,
    Canvas,
    AgentControl,
}

impl ProductFeatureGroup {
    pub const fn id(self) -> &'static str {
        match self {
            Self::Basic => "basic",
            Self::Git => "git",
            Self::Mcp => "mcp",
            Self::BrowserWeb => "browser-web",
            Self::ComputerUse => "computer-use",
            Self::ImageAnalysis => "image-analysis",
            Self::MiniApp => "miniapp",
            Self::Pages => "pages",
            Self::Creation => "creation",
            Self::Canvas => "canvas",
            Self::AgentControl => "agent-control",
        }
    }
}

impl fmt::Display for ProductFeatureGroup {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.id())
    }
}

impl From<ToolPackFeatureGroup> for ProductFeatureGroup {
    fn from(value: ToolPackFeatureGroup) -> Self {
        match value {
            ToolPackFeatureGroup::Basic => Self::Basic,
            ToolPackFeatureGroup::Git => Self::Git,
            ToolPackFeatureGroup::Mcp => Self::Mcp,
            ToolPackFeatureGroup::BrowserWeb => Self::BrowserWeb,
            ToolPackFeatureGroup::ComputerUse => Self::ComputerUse,
            ToolPackFeatureGroup::ImageAnalysis => Self::ImageAnalysis,
            ToolPackFeatureGroup::MiniApp => Self::MiniApp,
            ToolPackFeatureGroup::Pages => Self::Pages,
            ToolPackFeatureGroup::Creation => Self::Creation,
            ToolPackFeatureGroup::Canvas => Self::Canvas,
            ToolPackFeatureGroup::AgentControl => Self::AgentControl,
        }
    }
}

impl From<ProductFeatureGroup> for ToolPackFeatureGroup {
    fn from(value: ProductFeatureGroup) -> Self {
        match value {
            ProductFeatureGroup::Basic => Self::Basic,
            ProductFeatureGroup::Git => Self::Git,
            ProductFeatureGroup::Mcp => Self::Mcp,
            ProductFeatureGroup::BrowserWeb => Self::BrowserWeb,
            ProductFeatureGroup::ComputerUse => Self::ComputerUse,
            ProductFeatureGroup::ImageAnalysis => Self::ImageAnalysis,
            ProductFeatureGroup::MiniApp => Self::MiniApp,
            ProductFeatureGroup::Pages => Self::Pages,
            ProductFeatureGroup::Creation => Self::Creation,
            ProductFeatureGroup::Canvas => Self::Canvas,
            ProductFeatureGroup::AgentControl => Self::AgentControl,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProductCapabilityPack {
    id: ProductCapabilityId,
    required_services: &'static [RuntimeServiceCapability],
    tool_provider_group_ids: &'static [&'static str],
    agent_ids: &'static [&'static str],
}

impl ProductCapabilityPack {
    pub const fn new(
        id: ProductCapabilityId,
        required_services: &'static [RuntimeServiceCapability],
        tool_provider_group_ids: &'static [&'static str],
        agent_ids: &'static [&'static str],
    ) -> Self {
        Self {
            id,
            required_services,
            tool_provider_group_ids,
            agent_ids,
        }
    }

    pub const fn id(self) -> ProductCapabilityId {
        self.id
    }

    pub const fn required_services(self) -> &'static [RuntimeServiceCapability] {
        self.required_services
    }

    pub const fn tool_provider_group_ids(self) -> &'static [&'static str] {
        self.tool_provider_group_ids
    }

    pub const fn agent_ids(self) -> &'static [&'static str] {
        self.agent_ids
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[non_exhaustive]
pub enum DeliveryProfile {
    ProductFull,
    Desktop,
    DataMigrator,
    Cli,
    Server,
    Remote,
    Acp,
    Web,
    MobileWeb,
    Sdk,
}

impl DeliveryProfile {
    pub const fn id(self) -> &'static str {
        match self {
            Self::ProductFull => "product-full",
            Self::Desktop => "desktop",
            Self::DataMigrator => "data-migrator",
            Self::Cli => "cli",
            Self::Server => "server",
            Self::Remote => "remote",
            Self::Acp => "acp",
            Self::Web => "web",
            Self::MobileWeb => "mobile-web",
            Self::Sdk => "sdk",
        }
    }

    pub const fn all_current_product_profiles() -> &'static [DeliveryProfile] {
        &[
            Self::ProductFull,
            Self::Desktop,
            Self::DataMigrator,
            Self::Cli,
            Self::Server,
            Self::Remote,
            Self::Acp,
            Self::Web,
            Self::MobileWeb,
            Self::Sdk,
        ]
    }
}

impl fmt::Display for DeliveryProfile {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.id())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum ProductCoreDependencyMode {
    ProductFullCompatibility,
    ExplicitCoreCapabilityClosure,
    NoDirectCoreDependency,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProductDeliveryProfileEntry {
    profile: DeliveryProfile,
    core_dependency_mode: ProductCoreDependencyMode,
}

impl ProductDeliveryProfileEntry {
    pub const fn new(
        profile: DeliveryProfile,
        core_dependency_mode: ProductCoreDependencyMode,
    ) -> Self {
        Self {
            profile,
            core_dependency_mode,
        }
    }

    pub const fn profile(self) -> DeliveryProfile {
        self.profile
    }

    pub const fn core_dependency_mode(self) -> ProductCoreDependencyMode {
        self.core_dependency_mode
    }
}

const PRODUCT_DELIVERY_PROFILE_ENTRIES: &[ProductDeliveryProfileEntry] = &[
    ProductDeliveryProfileEntry::new(
        DeliveryProfile::ProductFull,
        ProductCoreDependencyMode::ProductFullCompatibility,
    ),
    ProductDeliveryProfileEntry::new(
        DeliveryProfile::Desktop,
        ProductCoreDependencyMode::ProductFullCompatibility,
    ),
    ProductDeliveryProfileEntry::new(
        DeliveryProfile::DataMigrator,
        ProductCoreDependencyMode::ExplicitCoreCapabilityClosure,
    ),
    ProductDeliveryProfileEntry::new(
        DeliveryProfile::Cli,
        ProductCoreDependencyMode::ExplicitCoreCapabilityClosure,
    ),
    ProductDeliveryProfileEntry::new(
        DeliveryProfile::Server,
        ProductCoreDependencyMode::NoDirectCoreDependency,
    ),
    ProductDeliveryProfileEntry::new(
        DeliveryProfile::Remote,
        ProductCoreDependencyMode::NoDirectCoreDependency,
    ),
    ProductDeliveryProfileEntry::new(
        DeliveryProfile::Acp,
        ProductCoreDependencyMode::ExplicitCoreCapabilityClosure,
    ),
    ProductDeliveryProfileEntry::new(
        DeliveryProfile::Web,
        ProductCoreDependencyMode::NoDirectCoreDependency,
    ),
    ProductDeliveryProfileEntry::new(
        DeliveryProfile::MobileWeb,
        ProductCoreDependencyMode::NoDirectCoreDependency,
    ),
    ProductDeliveryProfileEntry::new(
        DeliveryProfile::Sdk,
        ProductCoreDependencyMode::ExplicitCoreCapabilityClosure,
    ),
];

pub const fn product_delivery_profile_entries() -> &'static [ProductDeliveryProfileEntry] {
    PRODUCT_DELIVERY_PROFILE_ENTRIES
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ProductServiceCapabilityRequirement {
    capability_id: ProductCapabilityId,
    service_capability: RuntimeServiceCapability,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum ProductServiceCapabilityStatus {
    Available,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProductServiceCapabilityAvailability {
    requirement: ProductServiceCapabilityRequirement,
    status: ProductServiceCapabilityStatus,
}

impl ProductServiceCapabilityAvailability {
    pub const fn new(
        requirement: ProductServiceCapabilityRequirement,
        status: ProductServiceCapabilityStatus,
    ) -> Self {
        Self {
            requirement,
            status,
        }
    }

    pub const fn requirement(self) -> ProductServiceCapabilityRequirement {
        self.requirement
    }

    pub const fn status(self) -> ProductServiceCapabilityStatus {
        self.status
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProductCapabilitySet {
    ids: Vec<ProductCapabilityId>,
}

impl ProductCapabilitySet {
    pub fn new(ids: Vec<ProductCapabilityId>) -> Self {
        let mut deduped = Vec::new();
        for id in ids {
            if !deduped.contains(&id) {
                deduped.push(id);
            }
        }
        Self { ids: deduped }
    }

    pub fn ids(&self) -> &[ProductCapabilityId] {
        &self.ids
    }

    pub fn contains(&self, id: ProductCapabilityId) -> bool {
        self.ids.contains(&id)
    }
}

impl ProductServiceCapabilityRequirement {
    pub const fn new(
        capability_id: ProductCapabilityId,
        service_capability: RuntimeServiceCapability,
    ) -> Self {
        Self {
            capability_id,
            service_capability,
        }
    }

    pub const fn capability_id(self) -> ProductCapabilityId {
        self.capability_id
    }

    pub const fn service_capability(self) -> RuntimeServiceCapability {
        self.service_capability
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProductCapabilityAssembly {
    capability_ids: Vec<ProductCapabilityId>,
    agent_ids: Vec<&'static str>,
    feature_groups: Vec<ProductFeatureGroup>,
    service_requirements: Vec<ProductServiceCapabilityRequirement>,
    tool_provider_group_plan: Vec<ToolProviderGroupPlan>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProductToolPlan {
    feature_groups: Vec<ProductFeatureGroup>,
    tool_provider_group_plan: Vec<ToolProviderGroupPlan>,
}

impl ProductToolPlan {
    fn new(
        feature_groups: Vec<ProductFeatureGroup>,
        tool_provider_group_plan: Vec<ToolProviderGroupPlan>,
    ) -> Self {
        Self {
            feature_groups,
            tool_provider_group_plan,
        }
    }

    pub fn feature_groups(&self) -> &[ProductFeatureGroup] {
        &self.feature_groups
    }

    pub fn tool_provider_group_plan(&self) -> &[ToolProviderGroupPlan] {
        &self.tool_provider_group_plan
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProductAssemblyPlan {
    profile: DeliveryProfile,
    capability_set: ProductCapabilitySet,
    capability_assembly: ProductCapabilityAssembly,
    extension_capabilities: ProductExtensionCapabilitySet,
}

impl ProductAssemblyPlan {
    pub fn new(
        profile: DeliveryProfile,
        capability_set: ProductCapabilitySet,
        capability_assembly: ProductCapabilityAssembly,
        extension_capabilities: ProductExtensionCapabilitySet,
    ) -> Self {
        Self {
            profile,
            capability_set,
            capability_assembly,
            extension_capabilities,
        }
    }

    pub const fn profile(&self) -> DeliveryProfile {
        self.profile
    }

    pub fn capability_set(&self) -> &ProductCapabilitySet {
        &self.capability_set
    }

    pub fn capability_assembly(&self) -> &ProductCapabilityAssembly {
        &self.capability_assembly
    }

    pub fn agent_ids(&self) -> &[&'static str] {
        self.capability_assembly.agent_ids()
    }

    pub fn extension_capabilities(&self) -> &ProductExtensionCapabilitySet {
        &self.extension_capabilities
    }

    fn with_extension_capabilities(
        mut self,
        extension_capabilities: ProductExtensionCapabilitySet,
    ) -> Self {
        self.extension_capabilities = extension_capabilities;
        self
    }

    pub fn feature_groups(&self) -> &[ProductFeatureGroup] {
        self.capability_assembly.feature_groups()
    }

    pub fn feature_group_ids(&self) -> Vec<&'static str> {
        self.capability_assembly.feature_group_ids()
    }

    pub fn service_availability_report<F>(
        &self,
        mut is_available: F,
    ) -> Vec<ProductServiceCapabilityAvailability>
    where
        F: FnMut(RuntimeServiceCapability) -> bool,
    {
        self.capability_assembly
            .service_requirements()
            .iter()
            .copied()
            .map(|requirement| {
                let status = if is_available(requirement.service_capability()) {
                    ProductServiceCapabilityStatus::Available
                } else {
                    ProductServiceCapabilityStatus::Unavailable
                };
                ProductServiceCapabilityAvailability::new(requirement, status)
            })
            .collect()
    }

    pub fn tool_plan(&self) -> ProductToolPlan {
        self.capability_assembly.tool_plan()
    }
}

#[derive(Debug, Clone)]
pub struct ProductRuntimeAssembly {
    plan: ProductAssemblyPlan,
}

impl ProductRuntimeAssembly {
    pub fn for_profile(profile: DeliveryProfile) -> Self {
        Self {
            plan: product_assembly_plan_for_profile(profile),
        }
    }

    pub fn product_full() -> Self {
        Self::for_profile(DeliveryProfile::ProductFull)
    }

    pub fn plan(&self) -> &ProductAssemblyPlan {
        &self.plan
    }

    pub fn service_availability_report(
        &self,
        services: &RuntimeServices,
    ) -> Vec<ProductServiceCapabilityAvailability> {
        self.plan
            .service_availability_report(|capability| services.has_capability(capability))
    }

    pub fn missing_service_requirements(
        &self,
        services: &RuntimeServices,
    ) -> Vec<ProductServiceCapabilityRequirement> {
        self.plan
            .capability_assembly()
            .missing_service_requirements(|capability| services.has_capability(capability))
    }
}

#[derive(Debug, Clone)]
pub struct ProductAssemblyInput {
    profile: DeliveryProfile,
    services: RuntimeServices,
    plugin_runtime: Option<PluginRuntimeBinding>,
}

impl ProductAssemblyInput {
    pub const fn new(profile: DeliveryProfile, services: RuntimeServices) -> Self {
        Self {
            profile,
            services,
            plugin_runtime: None,
        }
    }

    pub const fn profile(&self) -> DeliveryProfile {
        self.profile
    }

    pub fn with_plugin_runtime(mut self, binding: PluginRuntimeBinding) -> Self {
        self.plugin_runtime = Some(binding);
        self
    }
}

#[derive(Debug)]
pub struct ProductRuntimeParts {
    plan: ProductAssemblyPlan,
    services: RuntimeServices,
    plugin_runtime: PluginRuntimeBinding,
    service_availability: Vec<ProductServiceCapabilityAvailability>,
    missing_service_requirements: Vec<ProductServiceCapabilityRequirement>,
}

impl ProductRuntimeParts {
    pub fn plan(&self) -> &ProductAssemblyPlan {
        &self.plan
    }

    pub fn services(&self) -> &RuntimeServices {
        &self.services
    }

    pub fn plugin_runtime(&self) -> &PluginRuntimeBinding {
        &self.plugin_runtime
    }

    pub fn service_availability(&self) -> &[ProductServiceCapabilityAvailability] {
        &self.service_availability
    }

    pub fn missing_service_requirements(&self) -> &[ProductServiceCapabilityRequirement] {
        &self.missing_service_requirements
    }

    /// Consume the assembled product output into runtime-builder inputs.
    pub fn into_runtime_parts(self) -> (RuntimeServices, PluginRuntimeBinding) {
        (self.services, self.plugin_runtime)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProductAssemblyError {
    MissingRuntimeServices {
        profile: DeliveryProfile,
        missing: Vec<ProductServiceCapabilityRequirement>,
    },
    UnsupportedPluginRuntime {
        profile: DeliveryProfile,
        availability: PluginRuntimeAvailability,
    },
}

impl fmt::Display for ProductAssemblyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingRuntimeServices { profile, missing } => {
                write!(
                    f,
                    "delivery profile {profile} is missing {} runtime service requirements",
                    missing.len()
                )
            }
            Self::UnsupportedPluginRuntime {
                profile,
                availability,
            } => {
                write!(
                    f,
                    "delivery profile {profile} does not support an executable P0 plugin runtime client: {availability:?}"
                )
            }
        }
    }
}

impl std::error::Error for ProductAssemblyError {}

#[derive(Debug, Clone, Copy, Default)]
pub struct ProductAssembler;

impl ProductAssembler {
    pub const fn new() -> Self {
        Self
    }

    pub fn assemble(
        &self,
        input: ProductAssemblyInput,
    ) -> Result<ProductRuntimeParts, ProductAssemblyError> {
        let assembly = ProductRuntimeAssembly::for_profile(input.profile);
        let service_availability = assembly.service_availability_report(&input.services);
        let missing_service_requirements = assembly.missing_service_requirements(&input.services);
        if !missing_service_requirements.is_empty() {
            return Err(ProductAssemblyError::MissingRuntimeServices {
                profile: input.profile,
                missing: missing_service_requirements,
            });
        }

        let plugin_runtime = input
            .plugin_runtime
            .unwrap_or_else(|| default_plugin_runtime_binding_for_profile(input.profile));
        let plugin_runtime_availability = plugin_runtime.availability();
        let is_plugin_client = plugin_runtime.is_client_binding();
        if is_plugin_client && !plugin_runtime_availability.is_executable() {
            return Err(ProductAssemblyError::UnsupportedPluginRuntime {
                profile: input.profile,
                availability: plugin_runtime_availability,
            });
        }
        if (is_plugin_client || plugin_runtime_availability.is_executable())
            && !delivery_profile_supports_executable_plugin_runtime(input.profile)
        {
            return Err(ProductAssemblyError::UnsupportedPluginRuntime {
                profile: input.profile,
                availability: plugin_runtime_availability,
            });
        }

        let plan = assembly.plan().clone().with_extension_capabilities(
            ProductExtensionCapabilitySet::new(plugin_runtime_availability),
        );

        Ok(ProductRuntimeParts {
            plan,
            services: input.services,
            plugin_runtime,
            service_availability,
            missing_service_requirements,
        })
    }
}

const fn delivery_profile_supports_executable_plugin_runtime(profile: DeliveryProfile) -> bool {
    matches!(
        profile,
        DeliveryProfile::ProductFull | DeliveryProfile::Desktop | DeliveryProfile::Cli
    )
}

fn default_plugin_runtime_binding_for_profile(profile: DeliveryProfile) -> PluginRuntimeBinding {
    match product_extension_capabilities_for_profile(profile).plugin_runtime() {
        PluginRuntimeAvailability::Disabled { reason }
        | PluginRuntimeAvailability::Unavailable { reason } => {
            PluginRuntimeBinding::disabled(reason)
        }
        PluginRuntimeAvailability::ProjectionOnly { reason } => {
            PluginRuntimeBinding::projection_only(reason)
        }
        PluginRuntimeAvailability::Available => {
            PluginRuntimeBinding::disabled(PluginRuntimeUnavailableReason::NotBuilt)
        }
        _ => PluginRuntimeBinding::disabled(PluginRuntimeUnavailableReason::NotBuilt),
    }
}

impl ProductCapabilityAssembly {
    fn new(
        capability_ids: Vec<ProductCapabilityId>,
        agent_ids: Vec<&'static str>,
        feature_groups: Vec<ProductFeatureGroup>,
        service_requirements: Vec<ProductServiceCapabilityRequirement>,
        tool_provider_group_plan: Vec<ToolProviderGroupPlan>,
    ) -> Self {
        Self {
            capability_ids,
            agent_ids,
            feature_groups,
            service_requirements,
            tool_provider_group_plan,
        }
    }

    pub fn capability_ids(&self) -> &[ProductCapabilityId] {
        &self.capability_ids
    }

    pub fn agent_ids(&self) -> &[&'static str] {
        &self.agent_ids
    }

    pub fn feature_groups(&self) -> &[ProductFeatureGroup] {
        &self.feature_groups
    }

    pub fn feature_group_ids(&self) -> Vec<&'static str> {
        self.feature_groups
            .iter()
            .map(|feature_group| feature_group.id())
            .collect()
    }

    pub fn service_requirements(&self) -> &[ProductServiceCapabilityRequirement] {
        &self.service_requirements
    }

    pub fn required_service_capabilities(&self) -> Vec<RuntimeServiceCapability> {
        let mut seen = HashSet::new();
        let mut capabilities = Vec::new();
        for requirement in &self.service_requirements {
            let capability = requirement.service_capability();
            if seen.insert(capability) {
                capabilities.push(capability);
            }
        }
        capabilities
    }

    pub fn missing_service_requirements<F>(
        &self,
        mut is_available: F,
    ) -> Vec<ProductServiceCapabilityRequirement>
    where
        F: FnMut(RuntimeServiceCapability) -> bool,
    {
        self.service_requirements
            .iter()
            .copied()
            .filter(|requirement| !is_available(requirement.service_capability()))
            .collect()
    }

    pub fn tool_provider_group_plan(&self) -> &[ToolProviderGroupPlan] {
        &self.tool_provider_group_plan
    }

    pub fn tool_plan(&self) -> ProductToolPlan {
        ProductToolPlan::new(
            self.feature_groups.clone(),
            self.tool_provider_group_plan.clone(),
        )
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ProductCapabilityRegistry {
    packs: &'static [ProductCapabilityPack],
}

impl ProductCapabilityRegistry {
    pub const fn new(packs: &'static [ProductCapabilityPack]) -> Self {
        Self { packs }
    }

    pub const fn packs(self) -> &'static [ProductCapabilityPack] {
        self.packs
    }

    pub fn capability_ids(self) -> Vec<ProductCapabilityId> {
        self.packs.iter().map(|pack| pack.id()).collect()
    }

    pub fn required_service_capabilities(self) -> Vec<RuntimeServiceCapability> {
        self.service_requirements()
            .into_iter()
            .map(|requirement| requirement.service_capability())
            .fold(Vec::new(), |mut capabilities, capability| {
                if !capabilities.contains(&capability) {
                    capabilities.push(capability);
                }
                capabilities
            })
    }

    pub fn service_requirements(self) -> Vec<ProductServiceCapabilityRequirement> {
        let mut seen = HashSet::new();
        let mut requirements = Vec::new();
        for pack in self.packs {
            for service_capability in pack.required_services() {
                let requirement =
                    ProductServiceCapabilityRequirement::new(pack.id(), *service_capability);
                if seen.insert(requirement) {
                    requirements.push(requirement);
                }
            }
        }
        requirements
    }

    pub fn tool_provider_group_ids(self) -> Vec<&'static str> {
        let mut seen = HashSet::new();
        let mut provider_ids = Vec::new();
        for pack in self.packs {
            for provider_id in pack.tool_provider_group_ids() {
                if seen.insert(*provider_id) {
                    provider_ids.push(*provider_id);
                }
            }
        }
        provider_ids
    }

    pub fn agent_ids(self) -> Vec<&'static str> {
        let mut seen = HashSet::new();
        let mut agent_ids = Vec::new();
        for pack in self.packs {
            for agent_id in pack.agent_ids() {
                if seen.insert(*agent_id) {
                    agent_ids.push(*agent_id);
                }
            }
        }
        agent_ids
    }

    pub fn try_tool_provider_group_plan(
        self,
    ) -> Result<Vec<ToolProviderGroupPlan>, ProductCapabilityBuildError> {
        let provider_ids = self.tool_provider_group_ids();
        try_product_tool_provider_group_plan_for_ids(&provider_ids)
    }

    pub fn tool_provider_group_plan(self) -> Vec<ToolProviderGroupPlan> {
        self.try_tool_provider_group_plan()
            .expect("product capability packs must reference known tool provider groups")
    }

    pub fn try_feature_groups(
        self,
    ) -> Result<Vec<ProductFeatureGroup>, ProductCapabilityBuildError> {
        let tool_provider_group_plan = self.try_tool_provider_group_plan()?;
        Ok(feature_groups_from_tool_provider_group_plan(
            &tool_provider_group_plan,
        ))
    }

    pub fn feature_groups(self) -> Vec<ProductFeatureGroup> {
        self.try_feature_groups()
            .expect("product capability packs must reference known tool provider groups")
    }

    pub fn try_build_assembly(
        self,
    ) -> Result<ProductCapabilityAssembly, ProductCapabilityBuildError> {
        let tool_provider_group_plan = self.try_tool_provider_group_plan()?;
        let feature_groups =
            feature_groups_from_tool_provider_group_plan(&tool_provider_group_plan);
        Ok(ProductCapabilityAssembly::new(
            self.capability_ids(),
            self.agent_ids(),
            feature_groups,
            self.service_requirements(),
            tool_provider_group_plan,
        ))
    }

    pub fn build_assembly(self) -> ProductCapabilityAssembly {
        self.try_build_assembly()
            .expect("product capability packs must build a valid assembly")
    }

    pub fn capability_set(self) -> ProductCapabilitySet {
        ProductCapabilitySet::new(self.capability_ids())
    }

    pub fn build_assembly_plan(self, profile: DeliveryProfile) -> ProductAssemblyPlan {
        let capability_set = self.capability_set();
        let capability_assembly = self.build_assembly();
        ProductAssemblyPlan::new(
            profile,
            capability_set,
            capability_assembly,
            product_extension_capabilities_for_profile(profile),
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProductExtensionCapabilitySet {
    plugin_runtime: PluginRuntimeAvailability,
}

impl ProductExtensionCapabilitySet {
    pub fn new(plugin_runtime: PluginRuntimeAvailability) -> Self {
        Self { plugin_runtime }
    }

    pub const fn plugin_runtime(&self) -> PluginRuntimeAvailability {
        self.plugin_runtime
    }
}

pub fn product_extension_capabilities_for_profile(
    profile: DeliveryProfile,
) -> ProductExtensionCapabilitySet {
    let plugin_runtime_reason = match profile {
        DeliveryProfile::ProductFull | DeliveryProfile::Desktop | DeliveryProfile::Cli => {
            PluginRuntimeUnavailableReason::NotBuilt
        }
        DeliveryProfile::Server
        | DeliveryProfile::Remote
        | DeliveryProfile::Acp
        | DeliveryProfile::DataMigrator
        | DeliveryProfile::Web
        | DeliveryProfile::MobileWeb
        | DeliveryProfile::Sdk => PluginRuntimeUnavailableReason::UnsupportedProfile,
    };

    ProductExtensionCapabilitySet::new(PluginRuntimeAvailability::disabled(plugin_runtime_reason))
}

fn feature_groups_from_tool_provider_group_plan(
    tool_provider_group_plan: &[ToolProviderGroupPlan],
) -> Vec<ProductFeatureGroup> {
    let mut seen = HashSet::new();
    let mut feature_groups = Vec::new();
    for group_plan in tool_provider_group_plan {
        for feature_group in group_plan.feature_groups() {
            let product_feature_group = ProductFeatureGroup::from(*feature_group);
            if seen.insert(product_feature_group) {
                feature_groups.push(product_feature_group);
            }
        }
    }
    feature_groups
}

const CODE_AGENT_SERVICES: &[RuntimeServiceCapability] = &[
    RuntimeServiceCapability::FileSystem,
    RuntimeServiceCapability::Workspace,
    RuntimeServiceCapability::SessionStore,
    RuntimeServiceCapability::Events,
    RuntimeServiceCapability::Clock,
    RuntimeServiceCapability::Terminal,
    RuntimeServiceCapability::Git,
    RuntimeServiceCapability::Network,
];
const DEEP_REVIEW_SERVICES: &[RuntimeServiceCapability] = &[
    RuntimeServiceCapability::Workspace,
    RuntimeServiceCapability::Git,
    RuntimeServiceCapability::Events,
];
const DEEP_RESEARCH_SERVICES: &[RuntimeServiceCapability] = &[
    RuntimeServiceCapability::Workspace,
    RuntimeServiceCapability::Network,
    RuntimeServiceCapability::Events,
];
const MINIAPP_SERVICES: &[RuntimeServiceCapability] = &[
    RuntimeServiceCapability::FileSystem,
    RuntimeServiceCapability::Workspace,
    RuntimeServiceCapability::Events,
];
const CANVAS_SERVICES: &[RuntimeServiceCapability] = &[
    RuntimeServiceCapability::FileSystem,
    RuntimeServiceCapability::Workspace,
    RuntimeServiceCapability::SessionStore,
    RuntimeServiceCapability::Events,
];

const CODE_AGENT_TOOL_GROUPS: &[&str] = &[
    "core.basic",
    "core.agent",
    "core.session",
    "core.git",
    "core.web",
    "core.mcp",
    "core.computer-use",
];
const DEEP_REVIEW_TOOL_GROUPS: &[&str] = &["core.review"];
const DEEP_RESEARCH_TOOL_GROUPS: &[&str] = &["core.web", "core.mcp"];
const MINIAPP_TOOL_GROUPS: &[&str] = &["core.miniapp"];
const CREATION_TOOL_GROUPS: &[&str] = &["core.creation", "core.miniapp"];
const CANVAS_TOOL_GROUPS: &[&str] = &["core.canvas"];

const CODE_AGENT_IDS: &[&str] = &[
    "OpenBitFun",
    "Minimal",
    "Standard",
    "Cowork",
    "Claw",
    "Ultimate",
    "SwarmPlanner",
    "SwarmWorker",
    "SwarmReviewer",
    "ComputerUse",
    "Explore",
    "GeneralPurpose",
    "GenerateDoc",
    "MemoryPhase2",
];
const DEEP_REVIEW_AGENT_IDS: &[&str] = &[
    "ReviewWorker",
    "ReviewJudge",
    "ReviewFixer",
    "CodeReview",
    "DeepReview",
];
const DEEP_RESEARCH_AGENT_IDS: &[&str] = &["DeepResearch", "ResearchSpecialist"];
const CREATION_AGENT_IDS: &[&str] = &["Creative"];
const NO_PRODUCT_AGENTS: &[&str] = &[];

const CODE_AGENT_CAPABILITY_PACK: ProductCapabilityPack = ProductCapabilityPack::new(
    ProductCapabilityId::CodeAgent,
    CODE_AGENT_SERVICES,
    CODE_AGENT_TOOL_GROUPS,
    CODE_AGENT_IDS,
);
const DEEP_REVIEW_CAPABILITY_PACK: ProductCapabilityPack = ProductCapabilityPack::new(
    ProductCapabilityId::DeepReview,
    DEEP_REVIEW_SERVICES,
    DEEP_REVIEW_TOOL_GROUPS,
    DEEP_REVIEW_AGENT_IDS,
);
const DEEP_RESEARCH_CAPABILITY_PACK: ProductCapabilityPack = ProductCapabilityPack::new(
    ProductCapabilityId::DeepResearch,
    DEEP_RESEARCH_SERVICES,
    DEEP_RESEARCH_TOOL_GROUPS,
    DEEP_RESEARCH_AGENT_IDS,
);
const MINIAPP_CAPABILITY_PACK: ProductCapabilityPack = ProductCapabilityPack::new(
    ProductCapabilityId::MiniApp,
    MINIAPP_SERVICES,
    MINIAPP_TOOL_GROUPS,
    NO_PRODUCT_AGENTS,
);
const PAGES_CAPABILITY_PACK: ProductCapabilityPack = ProductCapabilityPack::new(
    ProductCapabilityId::Pages,
    &[RuntimeServiceCapability::Network],
    &["core.pages"],
    NO_PRODUCT_AGENTS,
);
const CREATION_CAPABILITY_PACK: ProductCapabilityPack = ProductCapabilityPack::new(
    ProductCapabilityId::Creation,
    MINIAPP_SERVICES,
    CREATION_TOOL_GROUPS,
    CREATION_AGENT_IDS,
);
const CANVAS_CAPABILITY_PACK: ProductCapabilityPack = ProductCapabilityPack::new(
    ProductCapabilityId::Canvas,
    CANVAS_SERVICES,
    CANVAS_TOOL_GROUPS,
    NO_PRODUCT_AGENTS,
);
const VOICE_INPUT_CAPABILITY_PACK: ProductCapabilityPack =
    ProductCapabilityPack::new(ProductCapabilityId::VoiceInput, &[], &[], NO_PRODUCT_AGENTS);

const DEFAULT_PRODUCT_CAPABILITY_PACKS: &[ProductCapabilityPack] = &[
    CODE_AGENT_CAPABILITY_PACK,
    DEEP_REVIEW_CAPABILITY_PACK,
    DEEP_RESEARCH_CAPABILITY_PACK,
    MINIAPP_CAPABILITY_PACK,
    PAGES_CAPABILITY_PACK,
    CREATION_CAPABILITY_PACK,
    CANVAS_CAPABILITY_PACK,
    VOICE_INPUT_CAPABILITY_PACK,
];
const EMPTY_PRODUCT_CAPABILITY_PACKS: &[ProductCapabilityPack] = &[];

pub fn default_product_capability_registry() -> ProductCapabilityRegistry {
    ProductCapabilityRegistry::new(DEFAULT_PRODUCT_CAPABILITY_PACKS)
}

pub fn default_product_capability_assembly() -> ProductCapabilityAssembly {
    default_product_capability_registry().build_assembly()
}

pub fn agent_runtime_baseline_tool_plan() -> ProductToolPlan {
    let tool_provider_group_plan =
        try_product_tool_provider_group_plan_for_ids(&["core.basic", "core.agent", "core.session"])
            .expect("Agent Runtime baseline tool groups must exist");
    ProductToolPlan::new(
        vec![
            ProductFeatureGroup::Basic,
            ProductFeatureGroup::AgentControl,
        ],
        tool_provider_group_plan,
    )
}

pub fn product_assembly_plan_for_profile(profile: DeliveryProfile) -> ProductAssemblyPlan {
    product_capability_registry_for_profile(profile).build_assembly_plan(profile)
}

pub fn default_product_assembly_plan() -> ProductAssemblyPlan {
    product_assembly_plan_for_profile(DeliveryProfile::ProductFull)
}

fn product_capability_registry_for_profile(profile: DeliveryProfile) -> ProductCapabilityRegistry {
    match profile {
        DeliveryProfile::ProductFull | DeliveryProfile::Desktop => {
            default_product_capability_registry()
        }
        DeliveryProfile::Cli => {
            ProductCapabilityRegistry::new(&[CODE_AGENT_CAPABILITY_PACK, PAGES_CAPABILITY_PACK])
        }
        DeliveryProfile::Acp | DeliveryProfile::Sdk => {
            ProductCapabilityRegistry::new(&[CODE_AGENT_CAPABILITY_PACK])
        }
        DeliveryProfile::Server
        | DeliveryProfile::Remote
        | DeliveryProfile::DataMigrator
        | DeliveryProfile::Web
        | DeliveryProfile::MobileWeb => {
            ProductCapabilityRegistry::new(EMPTY_PRODUCT_CAPABILITY_PACKS)
        }
    }
}
