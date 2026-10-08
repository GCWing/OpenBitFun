//! Tool registry

use crate::agentic::tools::framework::{DynamicToolInfo, Tool};
use crate::agentic::tools::product_runtime::{
    resolve_product_readonly_enabled_tools, ProductToolRuntime,
};
use crate::util::errors::OpenBitFunResult;
use log::{debug, info, trace, warn};
use openbitfun_agent_tools::{
    DynamicToolDescriptor, DynamicToolProvider, PortResult, ToolDecoratorRef,
    ToolRegistry as AgentToolRegistry,
};
use openbitfun_product_capabilities::DeliveryProfile;
use std::sync::Arc;

pub(in crate::agentic::tools) type ToolRef = Arc<dyn Tool>;
pub(in crate::agentic::tools) type ProductToolDecoratorRef = ToolDecoratorRef<dyn Tool>;

fn route_external_tool_registration(tool: ToolRef) -> ToolRef {
    #[cfg(feature = "external-sources")]
    {
        return crate::external_tools::intercept_external_tool_registry_registration(tool);
    }
    #[cfg(not(feature = "external-sources"))]
    {
        tool
    }
}

fn detach_external_mcp_routes(server_id: &str) -> Vec<ToolRef> {
    #[cfg(feature = "external-sources")]
    {
        return crate::external_tools::detach_external_tool_mcp_server(server_id);
    }
    #[cfg(not(feature = "external-sources"))]
    {
        let _ = server_id;
        Vec::new()
    }
}

fn retain_external_tool_muxes(prefix: &str) -> Vec<ToolRef> {
    #[cfg(feature = "external-sources")]
    {
        return crate::external_tools::retain_external_tool_muxes_for_prefix(prefix);
    }
    #[cfg(not(feature = "external-sources"))]
    {
        let _ = prefix;
        Vec::new()
    }
}

fn notify_external_tool_registry_changed() {
    #[cfg(feature = "external-sources")]
    crate::external_sources::notify_external_tool_registry_changed();
}

pub use openbitfun_agent_tools::GET_TOOL_SPEC_TOOL_NAME;

/// Tool registry - manages all available tools (using IndexMap to maintain registration order)
pub struct ToolRegistry {
    inner: AgentToolRegistry<dyn Tool>,
}

impl Default for ToolRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl ToolRegistry {
    /// Create a new tool registry
    pub fn new() -> Self {
        ProductToolRuntime::default()
            .create_registry()
            .expect("the default tool runtime feature closure must be complete")
    }

    pub(in crate::agentic) fn for_profile(profile: DeliveryProfile) -> Result<Self, String> {
        ProductToolRuntime::for_profile(profile)
            .create_registry()
            .map_err(|error| error.to_string())
    }

    /// Create a registry with an injected decoration boundary.
    ///
    /// The default production decorator preserves snapshot-aware wrapping while
    /// allowing future owner crates to replace this concrete service coupling
    /// through the `openbitfun-runtime-ports` interface.
    pub fn with_tool_decorator(tool_decorator: ProductToolDecoratorRef) -> Self {
        ProductToolRuntime::with_tool_decorator(tool_decorator)
            .create_registry()
            .expect("the decorated default tool runtime feature closure must be complete")
    }

    pub(in crate::agentic::tools) fn from_inner(inner: AgentToolRegistry<dyn Tool>) -> Self {
        Self { inner }
    }

    /// Dynamically register MCP tools
    pub fn register_mcp_tools(&mut self, tools: Vec<ToolRef>) {
        let tool_count = tools.len();
        info!("Registering MCP tools: count={}", tool_count);

        let before_count = self.get_tool_names().len();
        debug!("Tool count before registration: {}", before_count);

        for (index, tool) in tools.into_iter().enumerate() {
            let name = tool.name().to_string();
            debug!(
                "Registering MCP tool [{}/{}]: {}",
                index + 1,
                tool_count,
                name
            );

            // Check if a tool with the same name already exists
            if self.get_tool(&name).is_some() {
                warn!(
                    "Tool already exists, will be overwritten: tool_name={}",
                    name
                );
            }

            let routed = route_external_tool_registration(tool);
            self.inner.register_tool(routed);
            debug!("MCP tool registered: tool_name={}", name);
        }

        if tool_count > 0 {
            notify_external_tool_registry_changed();
        }

        let after_count = self.get_tool_names().len();
        let added_count = after_count - before_count;

        info!(
            "MCP tools registration completed: before={}, after={}, added={}",
            before_count, after_count, added_count
        );
    }

    /// Remove all tools from the MCP server
    pub fn unregister_mcp_server_tools(&mut self, server_id: &str) {
        let retained_external_routes = detach_external_mcp_routes(server_id);
        let removed_tool_names = self
            .get_tool_names()
            .into_iter()
            .filter(|name| {
                self.get_dynamic_tool_info(name)
                    .and_then(|info| info.mcp)
                    .is_some_and(|mcp| mcp.server_id == server_id)
            })
            .collect::<Vec<_>>();

        self.inner.unregister_mcp_server_tools(server_id);

        for mux in retained_external_routes.iter().cloned() {
            self.register_tool_without_external_source_notification(mux);
        }

        if !retained_external_routes.is_empty() {
            notify_external_tool_registry_changed();
        }

        for key in removed_tool_names {
            info!("Unregistering dynamic tool: tool_name={}", key);
        }
    }

    /// Remove all tools whose registry name starts with the given prefix.
    pub fn unregister_tools_by_prefix(&mut self, prefix: &str) -> usize {
        let retained_muxes = retain_external_tool_muxes(prefix);
        let retained_names = retained_muxes
            .iter()
            .map(|tool| tool.name().to_string())
            .collect::<std::collections::BTreeSet<_>>();
        let removed_tool_names = self
            .get_tool_names()
            .into_iter()
            .filter(|name| name.starts_with(prefix))
            .collect::<Vec<_>>();
        let mut count = 0;
        for name in removed_tool_names
            .iter()
            .filter(|name| !retained_names.contains(*name))
        {
            count += usize::from(self.inner.unregister_tool(name).is_some());
        }
        for mux in retained_muxes.iter().cloned() {
            self.register_tool_without_external_source_notification(mux);
            count += 1;
        }

        if !retained_muxes.is_empty() {
            notify_external_tool_registry_changed();
        }

        for key in removed_tool_names {
            info!("Unregistering dynamic tool: tool_name={}", key);
        }

        count
    }

    /// Remove one exact tool while preserving the displaced implementation for
    /// a contextual conflict router.
    pub fn unregister_tool(&mut self, name: &str) -> Option<ToolRef> {
        self.inner.unregister_tool(name)
    }

    /// Register a single tool
    pub fn register_tool(&mut self, tool: ToolRef) {
        let is_router = tool.dynamic_provider_id() == Some("external-source-router");
        let routed = route_external_tool_registration(tool);
        self.inner.register_tool(routed);
        if !is_router {
            notify_external_tool_registry_changed();
        }
    }

    pub(crate) fn register_tool_without_external_source_notification(&mut self, tool: ToolRef) {
        self.inner.register_tool(tool);
    }

    /// Get tool
    pub fn get_tool(&self, name: &str) -> Option<Arc<dyn Tool>> {
        self.inner.get_tool(name)
    }

    pub fn get_dynamic_tool_info(&self, name: &str) -> Option<DynamicToolInfo> {
        self.inner.get_dynamic_tool_info(name)
    }

    pub fn is_tool_deferred(&self, name: &str) -> bool {
        self.inner.is_tool_deferred(name)
    }

    pub fn get_deferred_tool_names(&self) -> Vec<String> {
        self.inner.get_deferred_tool_names()
    }

    pub fn current_snapshot_generation(&self) -> u64 {
        self.inner.current_snapshot_generation()
    }

    /// Get all tool names
    pub fn get_tool_names(&self) -> Vec<String> {
        self.inner.get_tool_names()
    }

    /// Get all tools
    pub fn get_all_tools(&self) -> Vec<Arc<dyn Tool>> {
        trace!(
            "ToolRegistry::get_all_tools() called: total={}",
            self.get_tool_names().len()
        );
        self.inner.get_all_tools()
    }
}

#[async_trait::async_trait]
impl DynamicToolProvider for ToolRegistry {
    async fn list_dynamic_tools(&self) -> PortResult<Vec<DynamicToolDescriptor>> {
        self.inner.list_dynamic_tools().await
    }
}

/// Get all tools from the snapshot-aware global registry.
pub async fn get_all_tools() -> Vec<Arc<dyn Tool>> {
    let registry = get_global_tool_registry();
    let registry_lock = registry.read().await;
    registry_lock.get_all_tools()
}

/// Get readonly tools
pub async fn get_readonly_tools() -> OpenBitFunResult<Vec<Arc<dyn Tool>>> {
    Ok(resolve_product_readonly_enabled_tools().await)
}

/// Create default tool registry - factory function
pub fn create_tool_registry() -> ToolRegistry {
    ToolRegistry::new()
}

// Global tool registry instance
use std::sync::OnceLock;
use tokio::sync::RwLock as TokioRwLock;

struct GlobalToolRegistry {
    profile: Option<DeliveryProfile>,
    registry: Arc<TokioRwLock<ToolRegistry>>,
}

static GLOBAL_TOOL_REGISTRY: OnceLock<GlobalToolRegistry> = OnceLock::new();

pub(in crate::agentic) fn initialize_global_tool_registry_for_profile(
    profile: DeliveryProfile,
) -> Result<Arc<TokioRwLock<ToolRegistry>>, String> {
    if let Some(global) = GLOBAL_TOOL_REGISTRY.get() {
        return if global.profile == Some(profile) {
            Ok(global.registry.clone())
        } else {
            Err(format!(
                "Global tool registry already uses {}; cannot replace it with {}",
                global
                    .profile
                    .map(|selected| selected.to_string())
                    .unwrap_or_else(|| "the Agent Runtime baseline".to_string()),
                profile
            ))
        };
    }

    let candidate = GlobalToolRegistry {
        profile: Some(profile),
        registry: Arc::new(TokioRwLock::new(ToolRegistry::for_profile(profile)?)),
    };
    let _ = GLOBAL_TOOL_REGISTRY.set(candidate);
    let global = GLOBAL_TOOL_REGISTRY
        .get()
        .expect("global tool registry must be initialized");
    if global.profile != Some(profile) {
        return Err(format!(
            "Global tool registry concurrently selected {}; requested {}",
            global
                .profile
                .map(|selected| selected.to_string())
                .unwrap_or_else(|| "the Agent Runtime baseline".to_string()),
            profile
        ));
    }
    Ok(global.registry.clone())
}

/// Get global tool registry
pub fn get_global_tool_registry() -> Arc<TokioRwLock<ToolRegistry>> {
    GLOBAL_TOOL_REGISTRY
        .get_or_init(|| {
            info!("Initializing global tool registry");
            GlobalToolRegistry {
                #[cfg(feature = "product-full")]
                profile: Some(DeliveryProfile::ProductFull),
                #[cfg(not(feature = "product-full"))]
                profile: None,
                registry: Arc::new(TokioRwLock::new(ToolRegistry::new())),
            }
        })
        .registry
        .clone()
}

/// Backward-compatible alias for callers that expect MCP tools to be included.
pub async fn get_all_registered_tools() -> Vec<Arc<dyn Tool>> {
    get_all_tools().await
}

/// Get all registered tool names
pub async fn get_all_registered_tool_names() -> Vec<String> {
    let all_tools = get_all_registered_tools().await;
    all_tools
        .into_iter()
        .map(|tool| tool.name().to_string())
        .collect()
}

pub async fn get_readonly_registered_tool_names() -> Vec<String> {
    get_readonly_tools()
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|tool| tool.name().to_string())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::create_tool_registry;
    use super::ToolRef;
    use super::ToolRegistry;
    use crate::agentic::tools::framework::{
        DynamicMcpToolInfo, DynamicToolInfo, Tool, ToolResult, ToolUseContext, ValidationResult,
    };
    use crate::agentic::tools::product_runtime::ProductToolRuntime;
    use async_trait::async_trait;
    use openbitfun_agent_tools::{DynamicToolProvider, ToolDecorator};
    use serde_json::json;
    use serde_json::Value;
    use std::sync::Arc;

    struct DynamicMetadataTool {
        name: String,
        dynamic_info: Option<DynamicToolInfo>,
        exposure: crate::agentic::tools::framework::ToolExposure,
    }

    #[async_trait]
    impl Tool for DynamicMetadataTool {
        fn name(&self) -> &str {
            &self.name
        }

        async fn description(&self) -> crate::util::errors::OpenBitFunResult<String> {
            Ok("dynamic test tool".to_string())
        }

        fn short_description(&self) -> String {
            "dynamic test tool".to_string()
        }

        fn input_schema(&self) -> Value {
            json!({ "type": "object" })
        }

        fn default_exposure(&self) -> crate::agentic::tools::framework::ToolExposure {
            self.exposure
        }

        fn dynamic_provider_id(&self) -> Option<&str> {
            self.dynamic_info
                .as_ref()
                .map(|info| info.provider_id.as_str())
        }

        fn dynamic_tool_info(&self) -> Option<DynamicToolInfo> {
            self.dynamic_info.clone()
        }

        async fn validate_input(
            &self,
            _input: &Value,
            _context: Option<&ToolUseContext>,
        ) -> ValidationResult {
            ValidationResult {
                result: true,
                message: None,
                error_code: None,
                meta: None,
            }
        }

        async fn call_impl(
            &self,
            _input: &Value,
            _context: &ToolUseContext,
        ) -> crate::util::errors::OpenBitFunResult<Vec<ToolResult>> {
            Ok(Vec::new())
        }
    }

    fn dynamic_tool(name: &str, provider_id: Option<&str>) -> ToolRef {
        Arc::new(DynamicMetadataTool {
            name: name.to_string(),
            dynamic_info: provider_id.map(|provider_id| DynamicToolInfo {
                provider_id: provider_id.to_string(),
                provider_kind: None,
                mcp: None,
            }),
            exposure: crate::agentic::tools::framework::ToolExposure::Direct,
        })
    }

    fn mcp_dynamic_tool(
        name: &str,
        _provider_id: Option<&str>,
        server_id: &str,
        server_name: &str,
        tool_name: &str,
    ) -> ToolRef {
        Arc::new(DynamicMetadataTool {
            name: name.to_string(),
            dynamic_info: Some(DynamicToolInfo {
                provider_id: server_id.to_string(),
                provider_kind: Some("mcp".to_string()),
                mcp: Some(DynamicMcpToolInfo {
                    server_id: server_id.to_string(),
                    server_name: server_name.to_string(),
                    tool_name: tool_name.to_string(),
                }),
            }),
            exposure: crate::agentic::tools::framework::ToolExposure::Deferred,
        })
    }

    #[derive(Debug, Clone)]
    struct MarkerToolDecorator;

    impl ToolDecorator<ToolRef> for MarkerToolDecorator {
        fn decorate(&self, tool: ToolRef) -> ToolRef {
            Arc::new(DecoratedMarkerTool {
                name: tool.name().to_string(),
                exposure: tool.default_exposure(),
                readonly: tool.is_readonly(),
            })
        }
    }

    struct DecoratedMarkerTool {
        name: String,
        exposure: crate::agentic::tools::framework::ToolExposure,
        readonly: bool,
    }

    #[async_trait]
    impl Tool for DecoratedMarkerTool {
        fn name(&self) -> &str {
            &self.name
        }

        async fn description(&self) -> crate::util::errors::OpenBitFunResult<String> {
            Ok("decorated test tool".to_string())
        }

        fn short_description(&self) -> String {
            "decorated test tool".to_string()
        }

        fn default_exposure(&self) -> crate::agentic::tools::framework::ToolExposure {
            self.exposure
        }

        fn input_schema(&self) -> Value {
            json!({ "type": "object" })
        }

        fn is_readonly(&self) -> bool {
            self.readonly
        }

        async fn call_impl(
            &self,
            _input: &Value,
            _context: &ToolUseContext,
        ) -> crate::util::errors::OpenBitFunResult<Vec<ToolResult>> {
            Ok(Vec::new())
        }
    }

    #[cfg(feature = "tools-browser-web")]
    #[test]
    fn registry_includes_webfetch_tool() {
        let registry = create_tool_registry();
        assert!(registry.get_tool("WebFetch").is_some());
    }

    #[test]
    fn registry_includes_cron_tool() {
        let registry = create_tool_registry();
        assert!(registry.get_tool("Cron").is_some());
    }

    #[cfg(feature = "product-full")]
    #[test]
    fn registry_preserves_builtin_tool_manifest_for_owner_migration() {
        let registry = create_tool_registry();
        let expected_names = vec![
            "LS",
            "Read",
            "view_image",
            "analyze_image",
            "Glob",
            "Grep",
            "Write",
            "Edit",
            "Delete",
            "ExecCommand",
            "WriteStdin",
            "ExecControl",
            "GetTime",
            "ListModels",
            "Task",
            "AgentSpawn",
            "AgentSendInput",
            "AgentControl",
            "AgentList",
            "AgentWait",
            "LaunchReviewAgent",
            "Skill",
            "AskUserQuestion",
            "TodoWrite",
            "get_goal",
            "create_goal",
            "update_goal",
            "submit_code_review",
            "GetToolSpec",
            "CallDeferredTool",
            "OpenBitFunControl",
            "GetFileDiff",
            "CreateCanvas",
            "ReadCanvas",
            "UpdateCanvas",
            "PatchCanvas",
            "ListWorkspaces",
            "SessionControl",
            "SessionMessage",
            "SessionHistory",
            "Cron",
            "PortForward",
            "WebSearch",
            "WebFetch",
            "ListMCPResources",
            "ReadMCPResource",
            "ListMCPPrompts",
            "GetMCPPrompt",
            "GenerativeUI",
            "Worktree",
            "ReviewPlatform",
            "InitMiniApp",
            "FinalizeMiniApp",
            "PublishMiniApp",
            "FrontendWorkbench",
            "PublishAppearance",
            "PageDeploy",
            "PagePublish",
            "ControlHub",
            "ComputerUse",
            "Playbook",
        ];

        assert_eq!(
            registry.get_tool_names(),
            expected_names,
            "builtin tool manifest must stay stable before moving registry ownership"
        );
        let runtime_names = registry
            .get_all_tools()
            .iter()
            .map(|tool| tool.name().to_string())
            .collect::<Vec<_>>();
        assert_eq!(
            runtime_names,
            registry.get_tool_names(),
            "runtime tool collection order must match registry key order"
        );
    }

    #[cfg(feature = "product-full")]
    #[test]
    fn product_capability_provider_plan_covers_registry_manifest_without_owning_order() {
        let assembly = openbitfun_product_capabilities::default_product_capability_assembly();
        let mut provider_tools = assembly
            .tool_provider_group_plan()
            .iter()
            .flat_map(|group| group.tool_names())
            .map(|tool_name| tool_name.to_string())
            .collect::<Vec<_>>();
        let mut registry_tools = create_tool_registry().get_tool_names();
        provider_tools.sort();
        registry_tools.sort();

        assert_eq!(
            provider_tools, registry_tools,
            "provider-based assembly must cover the existing builtin registry manifest"
        );
    }

    #[test]
    fn product_capability_provider_plan_keeps_owner_group_order() {
        let assembly = openbitfun_product_capabilities::default_product_capability_assembly();
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
            ],
            "provider groups must preserve the reviewed atomic ownership order"
        );
    }

    #[test]
    fn product_tool_runtime_preserves_core_owned_registry_contract() {
        let runtime = ProductToolRuntime::default();
        let assembled_registry = runtime
            .create_registry()
            .expect("the default runtime plan must materialize");
        let compatibility_registry = create_tool_registry();

        assert_eq!(
            assembled_registry.get_tool_names(),
            compatibility_registry.get_tool_names(),
            "runtime assembly must preserve legacy create_tool_registry output"
        );
        assert_eq!(
            assembled_registry.get_deferred_tool_names(),
            compatibility_registry.get_deferred_tool_names(),
            "runtime assembly must preserve product deferred-tool catalog"
        );

        for tool_name in ["Write", "Edit", "Delete"] {
            let tool = assembled_registry
                .get_tool(tool_name)
                .unwrap_or_else(|| panic!("{tool_name} tool should be registered"));
            let assistant_text = tool.render_result_for_assistant(&json!({
                "success": true,
                "snapshot_recorded": true,
                "file_path": "workspace/demo.txt"
            }));

            assert!(
                assistant_text.contains("snapshot system"),
                "runtime assembly must preserve snapshot wrapping for {tool_name}"
            );
        }
    }

    #[test]
    fn product_tool_runtime_owner_preserves_registry_contract() {
        let runtime = ProductToolRuntime::default();
        let owner_registry = runtime
            .create_registry()
            .expect("the default runtime plan must materialize");
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
    fn product_tool_runtime_keeps_custom_decorator_provider_contract() {
        let registry = ProductToolRuntime::with_tool_decorator(Arc::new(MarkerToolDecorator))
            .create_registry()
            .expect("the decorated default runtime plan must materialize");
        let compatibility_registry = create_tool_registry();

        assert_eq!(
            registry.get_tool_names(),
            compatibility_registry.get_tool_names(),
            "custom decorator assembly must keep provider tool order stable"
        );
        assert_eq!(
            registry.get_deferred_tool_names(),
            compatibility_registry.get_deferred_tool_names(),
            "custom decorator assembly must keep deferred exposure stable"
        );

        for tool_name in ["Write", "GetToolSpec", "SessionControl"] {
            let tool = registry
                .get_tool(tool_name)
                .unwrap_or_else(|| panic!("{tool_name} tool should be registered"));
            assert_eq!(
                tool.short_description(),
                "decorated test tool",
                "custom decorator must be applied while preserving provider installation"
            );
        }
    }

    #[cfg(feature = "product-full")]
    #[test]
    fn registry_marks_deferred_tools_for_get_tool_spec() {
        let registry = create_tool_registry();

        assert!(registry.is_tool_deferred("GetFileDiff"));
        assert!(registry.is_tool_deferred("ListModels"));
        assert!(!registry.is_tool_deferred("GetToolSpec"));
        assert!(registry.is_tool_deferred("Worktree"));
        assert!(registry.is_tool_deferred("ReviewPlatform"));
        assert!(!registry.is_tool_deferred("InitMiniApp"));
        assert!(!registry.is_tool_deferred("FinalizeMiniApp"));
        assert!(!registry.is_tool_deferred("PublishMiniApp"));
        assert!(!registry.is_tool_deferred("PublishAppearance"));
    }

    #[cfg(feature = "product-full")]
    #[test]
    fn registry_preserves_deferred_tool_manifest_for_owner_migration() {
        let registry = create_tool_registry();

        assert_eq!(
            registry.get_deferred_tool_names(),
            vec![
                "ListModels",
                "GetFileDiff",
                "ListWorkspaces",
                "SessionControl",
                "SessionMessage",
                "SessionHistory",
                "Cron",
                "PortForward",
                "ListMCPResources",
                "ReadMCPResource",
                "ListMCPPrompts",
                "GetMCPPrompt",
                "GenerativeUI",
                "Worktree",
                "ReviewPlatform",
                "ControlHub",
                "Playbook",
            ],
            "deferred tool manifest must stay stable before moving registry or manifest ownership"
        );
    }

    #[cfg(feature = "product-full")]
    #[tokio::test]
    async fn registry_preserves_readonly_tool_manifest_for_owner_migration() {
        let readonly_names = super::get_readonly_tools()
            .await
            .expect("readonly tools")
            .iter()
            .map(|tool| tool.name().to_string())
            .collect::<Vec<_>>();

        assert_eq!(
            readonly_names,
            vec![
                "LS",
                "Read",
                "view_image",
                "analyze_image",
                "Glob",
                "Grep",
                "GetTime",
                "ListModels",
                "AgentList",
                "Skill",
                "AskUserQuestion",
                "TodoWrite",
                "get_goal",
                "submit_code_review",
                "GetToolSpec",
                "GetFileDiff",
                "ReadCanvas",
                "ListWorkspaces",
                "SessionHistory",
                "WebSearch",
                "WebFetch",
                "ListMCPResources",
                "ReadMCPResource",
                "ListMCPPrompts",
                "GetMCPPrompt",
                "GenerativeUI",
                "Playbook",
            ],
            "readonly tool manifest must stay stable before moving registry ownership"
        );
    }

    #[tokio::test]
    async fn dynamic_tool_provider_uses_explicit_provider_metadata() {
        let mut registry = ToolRegistry::new();
        registry.register_tool(dynamic_tool(
            "external_search",
            Some("github__enterprise/prod"),
        ));
        registry.register_tool(dynamic_tool("mcp__encoded__without_metadata", None));
        registry.register_tool(dynamic_tool("docs_lookup", Some("docs/provider")));

        let descriptors = registry
            .list_dynamic_tools()
            .await
            .expect("list dynamic tools");

        assert_eq!(
            descriptors
                .iter()
                .map(|descriptor| (descriptor.name.as_str(), descriptor.provider_id.as_deref()))
                .collect::<Vec<_>>(),
            vec![
                ("external_search", Some("github__enterprise/prod")),
                ("docs_lookup", Some("docs/provider")),
            ],
            "dynamic provider descriptors must keep explicit metadata and registration order"
        );
        assert_eq!(descriptors[0].name, "external_search");
        assert_eq!(
            descriptors[0].provider_id.as_deref(),
            Some("github__enterprise/prod")
        );
    }

    #[tokio::test]
    async fn dynamic_tool_provider_preserves_descriptor_shape_and_order() {
        let mut registry = ToolRegistry::new();
        registry.register_tool(dynamic_tool("external_search", Some("provider-a")));
        registry.register_tool(dynamic_tool("local_docs", Some("provider-b")));

        let descriptors = registry
            .list_dynamic_tools()
            .await
            .expect("list dynamic tools");

        let dynamic_descriptors = descriptors
            .iter()
            .map(|descriptor| {
                (
                    descriptor.name.as_str(),
                    descriptor.description.as_str(),
                    descriptor.input_schema.clone(),
                    descriptor.provider_id.as_deref(),
                )
            })
            .collect::<Vec<_>>();

        assert_eq!(
            dynamic_descriptors,
            vec![
                (
                    "external_search",
                    "dynamic test tool",
                    json!({ "type": "object" }),
                    Some("provider-a"),
                ),
                (
                    "local_docs",
                    "dynamic test tool",
                    json!({ "type": "object" }),
                    Some("provider-b"),
                ),
            ],
            "dynamic descriptor shape and registration order must remain stable before provider owner migration"
        );
    }

    #[tokio::test]
    async fn registering_static_tool_clears_stale_dynamic_metadata_for_same_name() {
        let mut registry = ToolRegistry::new();
        registry.register_tool(dynamic_tool("external_search", Some("provider-a")));
        assert!(
            registry.get_dynamic_tool_info("external_search").is_some(),
            "dynamic metadata should be registered before overwrite"
        );

        registry.register_tool(dynamic_tool("external_search", None));

        assert!(
            registry.get_dynamic_tool_info("external_search").is_none(),
            "stale dynamic metadata must be removed when a static tool overwrites a dynamic tool"
        );
        let descriptors = registry
            .list_dynamic_tools()
            .await
            .expect("list dynamic tools");
        assert!(
            descriptors
                .iter()
                .all(|descriptor| descriptor.name != "external_search"),
            "stale dynamic descriptor must not leak after static overwrite"
        );
    }

    #[tokio::test]
    async fn dynamic_tool_provider_prefers_mcp_registry_metadata() {
        let mut registry = ToolRegistry::new();
        registry.register_tool(mcp_dynamic_tool(
            "mcp__github__search_repos",
            Some("stale-provider-id"),
            "github-server-id",
            "GitHub",
            "search_repos",
        ));

        let descriptors = registry
            .list_dynamic_tools()
            .await
            .expect("list dynamic tools");

        let descriptor = descriptors
            .into_iter()
            .find(|item| item.name == "mcp__github__search_repos")
            .expect("mcp descriptor");

        assert_eq!(descriptor.provider_id.as_deref(), Some("github-server-id"));
        assert!(registry.is_tool_deferred("mcp__github__search_repos"));
        assert_eq!(
            registry
                .get_dynamic_tool_info("mcp__github__search_repos")
                .expect("mcp metadata")
                .mcp
                .expect("mcp subtype metadata")
                .tool_name,
            "search_repos"
        );
    }

    #[test]
    fn mcp_catalog_refresh_advances_generation_and_invalidates_loaded_specs() {
        let mut registry = ToolRegistry::new();
        registry.register_tool(mcp_dynamic_tool(
            "mcp__github__search_repos",
            None,
            "github-server-id",
            "GitHub",
            "search_repos",
        ));
        let loaded_generation = registry.current_snapshot_generation();

        registry.unregister_mcp_server_tools("github-server-id");
        let removed_generation = registry.current_snapshot_generation();
        assert!(removed_generation > loaded_generation);
        assert!(registry.get_tool("mcp__github__search_repos").is_none());

        registry.register_tool(mcp_dynamic_tool(
            "mcp__github__search_repos",
            None,
            "github-server-id",
            "GitHub",
            "search_repos",
        ));
        let refreshed_generation = registry.current_snapshot_generation();

        assert!(refreshed_generation > removed_generation);
        let error = openbitfun_agent_tools::validate_deferred_tool_usage(
            "mcp__github__search_repos",
            &["mcp__github__search_repos".to_string()],
            &[openbitfun_agent_tools::LoadedDeferredToolSpec {
                tool_name: "mcp__github__search_repos".to_string(),
                catalog_generation: loaded_generation,
            }],
            refreshed_generation,
            openbitfun_agent_tools::GET_TOOL_SPEC_TOOL_NAME,
        )
        .expect_err("refresh must invalidate the previously loaded MCP spec");

        assert!(error.to_string().contains("loaded spec for deferred tool"));
        assert!(error.to_string().contains("is stale"));
    }
    #[cfg(all(feature = "tools-browser-web", feature = "tools-computer-use"))]
    #[test]
    fn registry_exposes_controlhub_and_computer_use() {
        let registry = create_tool_registry();
        assert!(
            registry.get_tool("ControlHub").is_some(),
            "ControlHub must remain registered for browser/terminal/meta control"
        );
        assert!(
            registry.get_tool("ComputerUse").is_some(),
            "ComputerUse must be registered as the dedicated desktop automation tool"
        );
    }

    #[test]
    fn exact_unregister_returns_the_displaced_tool_and_clears_metadata() {
        let mut registry = ToolRegistry::new();
        registry.register_tool(dynamic_tool("external_search", Some("provider-a")));
        let generation = registry.current_snapshot_generation();

        let removed = registry
            .unregister_tool("external_search")
            .expect("registered tool should be returned");

        assert_eq!(removed.name(), "external_search");
        assert!(registry.get_tool("external_search").is_none());
        assert!(registry.get_dynamic_tool_info("external_search").is_none());
        assert!(registry.current_snapshot_generation() > generation);
    }

    #[test]
    fn registry_wraps_file_modification_tools_for_snapshot_tracking() {
        let registry = create_tool_registry();
        for tool_name in ["Write", "Edit", "Delete"] {
            let tool = registry
                .get_tool(tool_name)
                .unwrap_or_else(|| panic!("{tool_name} tool should be registered"));

            let assistant_text = tool.render_result_for_assistant(&json!({
                "success": true,
                "snapshot_recorded": true,
                "file_path": "workspace/demo.txt"
            }));

            assert!(
                assistant_text.contains("snapshot system"),
                "expected snapshot wrapper text for {tool_name}, got: {assistant_text}"
            );
            for recorded in [Value::Null, Value::Bool(false)] {
                let unrecorded_text = tool.render_result_for_assistant(&json!({
                    "success": true, "snapshot_recorded": recorded,
                    "file_path": "workspace/demo.txt"
                }));
                assert!(
                    !unrecorded_text.contains("snapshot system"),
                    "successful file mutation alone cannot claim snapshot coverage"
                );
            }
        }

        let read_text = registry
            .get_tool("Read")
            .expect("Read tool should be registered")
            .render_result_for_assistant(&json!({
                "content": "hello",
                "file_path": "workspace/demo.txt"
            }));
        assert!(
            !read_text.contains("snapshot system"),
            "readonly tool should not be snapshot wrapped: {read_text}"
        );
    }
}
