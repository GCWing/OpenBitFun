//! Product domain owner crate.
//!
//! Product subdomains live here when they can be compiled without depending on
//! the full OpenBitFun core runtime assembly.

pub mod account;
pub mod agent_catalog;
pub mod canvas;
pub mod mcp;
pub mod native_hooks;
pub mod product_control;
pub mod product_control_owner_registry;
pub mod product_release;
pub mod product_search;
pub mod remote_surface;
#[cfg(feature = "external-sources")]
pub mod session_import;
pub mod tool_permissions;

#[cfg(feature = "appearance-market")]
pub mod appearance_market;

#[cfg(feature = "external-sources")]
pub mod external_integration_policy;

#[cfg(feature = "external-sources")]
pub mod external_hook_contributions;

#[cfg(feature = "external-sources")]
pub mod external_hook_catalog;

#[cfg(feature = "external-sources")]
pub mod external_hook_import;

#[cfg(feature = "external-sources")]
pub mod external_source_control;

#[cfg(feature = "external-sources")]
pub mod external_sources;

#[cfg(feature = "external-sources")]
pub mod external_subagents;

#[cfg(feature = "external-sources")]
pub mod plugin_capabilities;

#[cfg(feature = "external-sources")]
pub mod workspace_references;

#[cfg(feature = "plugin-source")]
pub mod plugin_source;

#[cfg(feature = "miniapp")]
pub mod miniapp;

#[cfg(feature = "function-agents")]
pub mod function_agents;

#[cfg(feature = "legacy-migration")]
pub mod legacy_migration;
