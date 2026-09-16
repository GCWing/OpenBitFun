//! Tool system - includes Tool interface, tool registry and tool executor

pub mod account_login_capability;
#[cfg(feature = "browser-control")]
pub mod browser_control;
pub mod computer_use_capability;
pub mod computer_use_host;
pub mod computer_use_optimizer;
pub(crate) mod file_permissions;
pub mod file_tool_guidance;
pub mod framework;
#[cfg(feature = "tools-creation")]
pub mod frontend_workbench_host;
pub mod image_context;
pub mod implementations;
mod integer_parser;
pub mod manifest_resolver;
#[cfg(feature = "tools-miniapp")]
pub(crate) mod miniapp_context_runtime;
pub mod openbitfun_control_config;
pub mod openbitfun_control_host;
#[cfg(feature = "tools-pages")]
pub mod page_deploy_host;
#[cfg(feature = "tools-pages")]
pub mod page_publish_host;
pub mod pipeline;
#[cfg(feature = "plugin-runtime")]
#[cfg(feature = "opencode-plugin-host")]
pub mod plugin_host_tool;
pub(crate) mod post_call_hooks;
#[doc(hidden)]
pub mod product_runtime;
pub mod registry;
pub mod restrictions;
pub mod review_read_receipt_runtime;
pub(crate) mod tool_adapter;
pub(crate) mod tool_context_runtime;
pub(crate) mod tool_result_storage;
pub mod user_input_manager;
pub mod workspace_paths;
pub use integer_parser::{parse_i64_value, parse_u64_value};
pub use openbitfun_agent_tools::input_validator;

pub use framework::{
    PortableToolContextProvider, Tool, ToolContextFacts, ToolResult, ToolUseContext,
    ToolWorkspaceKind, ValidationResult,
};
pub use image_context::{ImageContextData, ImageContextProvider, ImageContextProviderRef};
pub use input_validator::InputValidator;
pub use manifest_resolver::{
    resolve_tool_manifest, resolve_visible_tools, ResolvedToolManifest, ResolvedVisibleTools,
};
pub use pipeline::*;
pub use registry::{
    create_tool_registry, get_all_registered_tool_names, get_all_registered_tools, get_all_tools,
    get_readonly_registered_tool_names, get_readonly_tools,
};
pub use restrictions::{
    is_miniapp_headless_agent_run, is_miniapp_market_strict_agent_run,
    miniapp_agent_run_tool_restrictions, miniapp_headless_agent_tool_restrictions,
    miniapp_market_strict_agent_tool_restrictions, tool_restrictions_for_delegation_policy,
    ToolPathOperation, ToolPathPolicy, ToolRuntimeRestrictions,
};
