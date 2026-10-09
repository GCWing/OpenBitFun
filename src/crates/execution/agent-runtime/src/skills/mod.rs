//! Provider-neutral skill contracts and runtime decisions.
//!
//! This module owns skill DTOs, built-in catalog facts, mode default policy,
//! override resolution, markdown parsing, and assistant-visible payload
//! rendering. Product hosts still own filesystem/config IO and registry
//! scanning.

#[cfg(feature = "agent-runtime")]
mod catalog;
mod hooks;
#[cfg(feature = "agent-runtime")]
mod keys;
#[cfg(feature = "agent-runtime")]
mod policy;
#[cfg(feature = "agent-runtime")]
mod resolver;
mod roots;
pub use hooks::SkillHooks;
#[cfg(feature = "agent-runtime")]
mod selection;
mod types;

#[cfg(feature = "agent-runtime")]
pub use catalog::builtin_skill_group_key;
#[cfg(feature = "agent-runtime")]
pub use policy::resolve_builtin_default_enabled;
#[cfg(feature = "agent-runtime")]
pub use resolver::{
    normalize_user_mode_skill_overrides, resolve_skill_default_enabled_for_mode,
    resolve_skill_state_for_mode, ModeSkillState, UserModeSkillOverrides,
};
pub use roots::{
    normalize_local_skill_dir_name, normalize_remote_skill_dir_name,
    resolve_user_config_skill_root, SkillRootSpec, OPENBITFUN_SKILL_SOURCE_ID,
    OPENBITFUN_SKILL_SOURCE_LABEL, OPENBITFUN_SYSTEM_SKILL_DIR, OPENBITFUN_SYSTEM_SKILL_SLOT,
    OPENBITFUN_USER_SKILL_SLOT, PROJECT_SKILL_KEY_PREFIX, PROJECT_SKILL_ROOTS,
    USER_CONFIG_SKILL_ROOTS, USER_HOME_SKILL_ROOTS, USER_SKILL_KEY_PREFIX,
};
#[cfg(feature = "agent-runtime")]
pub use selection::{
    annotate_shadowed_skills, build_mode_skill_infos, filter_candidates_for_mode,
    filter_implicitly_invocable_skills, filter_user_invocable_skills, is_skill_globally_enabled,
    normalize_skill_keys, resolve_default_hidden_builtin_for_explicit_invocation,
    resolve_visible_skills, sort_skill_candidates_by_dir, sort_skills,
    ExplicitSkillInvocationResolution, SkillCandidate,
};
pub use types::{
    render_loaded_skill_for_assistant, ModeSkillInfo, ModeSkillStateReason, SkillData,
    SkillImportOrigin, SkillInfo, SkillLocation, SkillParseError, SkillScanDiagnostic,
    SkillScanReport,
};
