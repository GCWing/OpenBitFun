//! OpenCode-compatible plugin adapter.
//!
//! The production surface is intentionally small: load OpenCode-compatible
//! managed package content and optional activation authority as a plugin runtime
//! adapter, typed dispatch targets, and runtime-free Hook descriptor
//! mapping. The adapter does not execute JavaScript, install npm packages, or
//! depend on a user-local `opencode` CLI.

mod agent_source;
mod command_source;
mod hook_contributions;
mod hook_source;
mod instruction_source;
mod local_source_paths;
mod mcp_source;
mod plugin_config_projection;
mod reference_source;
pub mod session;
mod skill_source;
mod source_adapter;
mod tool_source;

pub use agent_source::{OpenCodeSubagentProvider, OpenCodeSubagentProviderOptions};
pub use command_source::{OpenCodeCommandProvider, OpenCodeCommandProviderOptions};
pub use hook_source::{OpenCodeHookProvider, OpenCodeHookProviderOptions};
pub use instruction_source::{load_opencode_user_instructions, OpenCodeInstructionSourceOptions};
pub use mcp_source::{OpenCodeMcpProvider, OpenCodeMcpProviderOptions};
pub use plugin_config_projection::{
    project_plugin_config, project_plugin_tool_ref, OpenCodePluginConfigProjectionError,
};
pub use reference_source::{
    OpenCodeWorkspaceReferenceProvider, OpenCodeWorkspaceReferenceProviderOptions,
};
pub use skill_source::{
    OpenCodeConfiguredSkillRoot, OpenCodeSkillRootDiagnostic, OpenCodeSkillRootProvider,
    OpenCodeSkillRootProviderOptions, OpenCodeSkillRootReport,
};
pub use source_adapter::{
    load_opencode_config_snapshot, load_opencode_package_adapter, OpenCodeConfigSnapshot,
    OpenCodeConfigSnapshotError,
};
pub use tool_source::{OpenCodeToolProvider, OpenCodeToolProviderOptions};
