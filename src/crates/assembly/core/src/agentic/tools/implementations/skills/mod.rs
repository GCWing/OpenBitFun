//! Skill management module
//!
//! Provides Skill registry, loading, and configuration management functionality

pub mod builtin;
pub mod catalog;
pub mod mode_overrides;
pub mod policy;
pub mod registry;
pub mod resolver;
mod runtime_settings;
#[cfg(feature = "file-watch")]
mod source_cache;
pub mod types;

pub use registry::SkillRegistry;
pub use types::{
    render_loaded_skill_for_assistant, ModeSkillInfo, ModeSkillStateReason, SkillData, SkillInfo,
    SkillLocation, SkillScanDiagnostic, SkillScanReport,
};

/// Get global Skill registry instance
pub fn get_skill_registry() -> &'static SkillRegistry {
    SkillRegistry::global()
}
