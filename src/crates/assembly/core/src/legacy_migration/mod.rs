//! Pre-rename data boundary. The adapters are a compatibility export; the
//! standalone migration service owns them.
mod assistant_workspace_root;

pub(crate) use assistant_workspace_root::legacy_assistant_workspace_root;
#[cfg(feature = "legacy-migration")]
pub use openbitfun_legacy_migration_adapters::adapters_for_groups;
