//! Core service owner crate.
//!
//! This crate owns platform-agnostic service building blocks that can be
//! tested without compiling the full OpenBitFun product runtime.

pub mod bounded_fs;
#[cfg(feature = "coordination-store")]
pub mod coordination_persistence;
#[cfg(feature = "credential-vault")]
pub mod credential_vault;
#[cfg(feature = "diagnostics")]
pub mod diagnostics;
#[cfg(feature = "diff")]
pub mod diff;
pub mod dispatch_contract;
#[cfg(feature = "dispatch-workspace")]
pub mod dispatch_workspace;
#[cfg(any(feature = "local-storage", feature = "runtime-ownership"))]
pub mod exclusive_file_lease;
#[cfg(any(feature = "local-storage", feature = "runtime-ownership"))]
mod file_lock;
#[cfg(any(feature = "filesystem", feature = "workspace-transfer"))]
pub mod file_write_lock;
#[cfg(feature = "filesystem")]
pub mod filesystem;
#[cfg(any(feature = "markdown", feature = "workspace-instructions"))]
pub mod instruction_scope;
#[cfg(any(feature = "json-io", feature = "local-storage"))]
pub mod json_store;
pub mod jsonc;
pub mod local_instructions;
#[cfg(feature = "workspace-runtime")]
pub mod local_runtime_ports;
#[cfg(feature = "process-runtime")]
pub mod managed_runtime;
#[cfg(feature = "markdown")]
pub mod markdown;
#[cfg(feature = "memory-store")]
pub mod memory_store;
#[cfg(feature = "permission")]
pub mod permission_store;
#[cfg(feature = "local-storage")]
pub mod persistence;
#[cfg(feature = "pet-packages")]
pub mod pet_packages;
#[cfg(feature = "process-runtime")]
pub mod process_manager;
#[cfg(feature = "process-runtime")]
pub mod process_tree;
#[cfg(feature = "session-event-format")]
pub mod session_projection_format;
pub mod storage_error;
#[cfg(feature = "workspace-persistence")]
pub mod workspace_persistence;
#[cfg(feature = "workspace-persistence")]
pub mod workspace_records;
#[cfg(any(
    feature = "filesystem",
    feature = "local-storage",
    feature = "product-identity"
))]
pub use openbitfun_core_types::product_identity;
#[cfg(feature = "runtime-ownership")]
pub mod runtime_ownership;
#[cfg(feature = "local-storage")]
pub mod session;
#[cfg(feature = "session-recovery")]
pub mod session_recovery;
#[cfg(feature = "session-search")]
pub mod session_search;
#[cfg(feature = "local-storage")]
pub mod session_usage;
#[cfg(feature = "local-storage")]
pub mod storage_cleanup;
#[cfg(feature = "process-runtime")]
pub mod system;
#[cfg(feature = "tls-provider")]
pub mod tls_provider;
#[cfg(feature = "local-storage")]
pub mod token_usage;
#[cfg(feature = "workspace-runtime")]
pub mod workspace;
#[cfg(feature = "workspace-identity")]
pub mod workspace_identity;
#[cfg(feature = "workspace-instructions")]
pub mod workspace_instructions;
pub mod workspace_text;
#[cfg(feature = "workspace-transfer")]
pub mod workspace_transfer;

#[cfg(feature = "asar")]
pub mod asar;

#[cfg(all(feature = "installed-apps", target_os = "windows"))]
pub mod installed_apps;
