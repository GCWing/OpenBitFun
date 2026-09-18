//! Skill registry
//!
//! Manages skill discovery, mode-specific filtering, and loading.

use super::builtin::ensure_builtin_skills_installed;
use super::mode_overrides::{
    load_disabled_mode_skills_local, load_disabled_mode_skills_remote,
    load_globally_disabled_project_skills, load_globally_disabled_user_skills,
    load_user_mode_skill_overrides, SkillPolicyWorkspace, UserModeSkillOverrides,
};
#[cfg(feature = "file-watch")]
use super::source_cache::{LocalSkillWatchMonitor, LocalSkillWatchRoot, VersionedSnapshotCache};
use super::types::{
    ModeSkillInfo, SkillData, SkillInfo, SkillLocation, SkillScanDiagnostic, SkillScanReport,
};
use crate::agentic::workspace::WorkspaceFileSystem;
#[cfg(feature = "external-sources")]
use crate::external_sources::{
    opencode_configured_skill_roots, pi_configured_skill_roots,
    LocalConfiguredSkillRootContribution,
};
use crate::infrastructure::get_path_manager_arc;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use futures::{stream, StreamExt};
use log::{debug, error, warn};
#[cfg(feature = "external-sources")]
use openbitfun_agent_runtime::skills::normalize_local_skill_dir_name;
use openbitfun_agent_runtime::skills::{
    annotate_shadowed_skills, build_mode_skill_infos, filter_candidates_for_mode,
    filter_implicitly_invocable_skills, filter_user_invocable_skills, is_skill_globally_enabled,
    normalize_skill_keys, resolve_default_hidden_builtin_for_explicit_invocation,
    resolve_user_config_skill_root, resolve_visible_skills, sort_skill_candidates_by_dir,
    sort_skills, ExplicitSkillInvocationResolution, SkillCandidate, OPENBITFUN_SKILL_SOURCE_ID,
    OPENBITFUN_SKILL_SOURCE_LABEL, OPENBITFUN_SYSTEM_SKILL_DIR, OPENBITFUN_SYSTEM_SKILL_SLOT,
    OPENBITFUN_USER_SKILL_SLOT, PROJECT_SKILL_KEY_PREFIX, PROJECT_SKILL_ROOTS,
    USER_CONFIG_SKILL_ROOTS, USER_HOME_SKILL_ROOTS, USER_SKILL_KEY_PREFIX,
};
use openbitfun_services_core::bounded_fs::is_symlink_or_reparse;
#[cfg(feature = "external-sources")]
use openbitfun_services_core::bounded_fs::{
    collect_bounded_regular_files, BoundedDirectoryWalkLimits,
};
#[cfg(feature = "external-sources")]
use openbitfun_services_core::bounded_fs::{read_bounded_text, BoundedTextRead};
#[cfg(feature = "external-sources")]
use openbitfun_services_core::workspace_text::read_workspace_relative_text_bounded;
#[cfg(feature = "external-sources")]
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tokio::fs;

mod discovery;
pub mod imports;

#[cfg(feature = "external-sources")]
const MAX_OPENCODE_CONFIGURED_SKILL_ROOTS: usize = 64;
#[cfg(feature = "external-sources")]
const MAX_OPENCODE_CONFIGURED_SKILLS_PER_ROOT: usize = 512;
#[cfg(feature = "external-sources")]
const MAX_OPENCODE_CONFIGURED_SKILL_BYTES: usize = 256 * 1024;
#[cfg(feature = "external-sources")]
const MAX_OPENCODE_CONFIGURED_POLICY_BYTES: usize = 64 * 1024;
#[cfg(feature = "external-sources")]
const OPENCODE_CONFIGURED_PRIORITY_BAND: usize =
    MAX_OPENCODE_CONFIGURED_SKILL_ROOTS * MAX_OPENCODE_CONFIGURED_SKILLS_PER_ROOT;

// Bound remote IO across the whole scan, including workspaces with many roots.
const REMOTE_SKILL_SCAN_CONCURRENCY: usize = 4;

const DEEP_RESEARCH_AGENT_ID: &str = "DeepResearch";
const DEEP_RESEARCH_SKILL_NAME: &str = "deep-research";

fn filter_implicitly_invocable_skills_for_agent(
    skills: Vec<SkillInfo>,
    agent_type: Option<&str>,
) -> Vec<SkillInfo> {
    let skills = filter_implicitly_invocable_skills(skills);
    if agent_type != Some(DEEP_RESEARCH_AGENT_ID) {
        return skills;
    }

    skills
        .into_iter()
        .filter(|skill| !skill.name.eq_ignore_ascii_case(DEEP_RESEARCH_SKILL_NAME))
        .collect()
}

#[cfg(test)]
mod implicit_invocation_policy_tests {
    use super::{filter_implicitly_invocable_skills_for_agent, SkillInfo, SkillLocation};

    fn skill(name: &str, allow_implicit_invocation: bool) -> SkillInfo {
        SkillInfo {
            key: format!("project::codex::{name}"),
            name: name.to_string(),
            description: String::new(),
            path: format!("/workspace/.codex/skills/{name}"),
            level: SkillLocation::Project,
            source_slot: "codex".to_string(),
            source_id: "codex".to_string(),
            source_label: "Codex".to_string(),
            installation_source: None,
            import_origin: None,
            entry_file: None,
            dir_name: name.to_string(),
            is_builtin: false,
            group_key: None,
            is_shadowed: false,
            shadowed_by_key: None,
            allow_implicit_invocation,
            allow_user_invocation: true,
            argument_hint: None,
        }
    }

    #[test]
    fn native_deep_research_hides_its_same_named_skill_from_implicit_listing() {
        let skills = vec![
            skill("deep-research", true),
            skill("Deep-Research", true),
            skill("fact-check", true),
            skill("academic-deep-research", true),
        ];

        let filtered = filter_implicitly_invocable_skills_for_agent(skills, Some("DeepResearch"));

        assert_eq!(filtered.len(), 2);
        assert_eq!(filtered[0].name, "fact-check");
        assert_eq!(filtered[1].name, "academic-deep-research");
    }

    #[test]
    fn same_named_skill_remains_available_outside_native_deep_research() {
        for agent_type in [Some("Cowork"), None] {
            let skills = vec![skill("deep-research", true)];
            let filtered = filter_implicitly_invocable_skills_for_agent(skills, agent_type);

            assert_eq!(filtered.len(), 1);
            assert_eq!(filtered[0].name, "deep-research");
        }
    }

    #[test]
    fn explicit_only_policy_still_applies_before_agent_specific_filtering() {
        let skills = vec![skill("academic-deep-research", false)];

        let filtered = filter_implicitly_invocable_skills_for_agent(skills, Some("DeepResearch"));

        assert!(filtered.is_empty());
    }
}

/// Global Skill registry instance
static SKILL_REGISTRY: OnceLock<SkillRegistry> = OnceLock::new();

#[derive(Debug, Clone)]
struct SkillRootEntry {
    path: PathBuf,
    level: SkillLocation,
    slot: &'static str,
    source_id: &'static str,
    source_label: &'static str,
    priority: usize,
    is_builtin: bool,
}

#[derive(Debug, Clone)]
struct RemoteSkillRootEntry {
    path: String,
    slot: &'static str,
    source_id: &'static str,
    source_label: &'static str,
    priority: usize,
}

#[derive(Debug, Clone)]
struct UserSkillSources {
    standard: Vec<SkillCandidate>,
    diagnostics: Vec<SkillScanDiagnostic>,
    #[cfg(feature = "file-watch")]
    cacheable: bool,
    #[cfg(feature = "file-watch")]
    watch_roots: Vec<LocalSkillWatchRoot>,
}

struct LocalSkillScan {
    candidates: Vec<SkillCandidate>,
    diagnostics: Vec<SkillScanDiagnostic>,
    cacheable: bool,
}

#[derive(Default)]
struct SkillCandidateScan {
    candidates: Vec<SkillCandidate>,
    diagnostics: Vec<SkillScanDiagnostic>,
}

impl SkillCandidateScan {
    fn into_candidates(self) -> Vec<SkillCandidate> {
        for diagnostic in &self.diagnostics {
            warn!(
                "Skill discovery notice: path={}, source={}, detail={}",
                diagnostic.path, diagnostic.source_id, diagnostic.message
            );
        }
        self.candidates
    }
}

async fn local_source_path_is_cacheable(path: &Path) -> bool {
    match fs::symlink_metadata(path).await {
        Ok(metadata) => !is_symlink_or_reparse(&metadata),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
        Err(_) => false,
    }
}

// The skills installer records repository provenance separately from SKILL.md.
// Read existing lock versions without rewriting them; a missing origin must
// never turn a name-only match into an installed marketplace package.
fn parse_skill_installation_sources(content: &str) -> HashMap<String, String> {
    let lock: serde_json::Value = match serde_json::from_str(content) {
        Ok(lock) => lock,
        Err(error) => {
            warn!("Ignoring invalid skill installation provenance: {}", error);
            return HashMap::new();
        }
    };
    lock.get("skills")
        .and_then(serde_json::Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(name, entry)| {
            if entry.get("sourceType").and_then(serde_json::Value::as_str) != Some("github") {
                return None;
            }
            let source = entry.get("source")?.as_str()?.trim();
            (!source.is_empty()).then(|| (name.clone(), source.to_string()))
        })
        .collect()
}

fn skill_installation_lock_path(entry: &SkillRootEntry) -> Option<PathBuf> {
    match (entry.level, entry.slot) {
        (SkillLocation::Project, "agents") => {
            Some(entry.path.parent()?.parent()?.join("skills-lock.json"))
        }
        (SkillLocation::User, "home.agents") => {
            let default_path = entry.path.parent()?.join(".skill-lock.json");
            Some(
                std::env::var_os("XDG_STATE_HOME")
                    .filter(|path| !path.is_empty())
                    .map(|path| PathBuf::from(path).join("skills/.skill-lock.json"))
                    .unwrap_or(default_path),
            )
        }
        _ => None,
    }
}

#[cfg(test)]
mod local_skill_scan_tests {
    use super::{SkillLocation, SkillRegistry, SkillRootEntry};
    use std::fs;
    use std::path::Path;

    #[tokio::test]
    async fn codex_home_override_discovers_skills_without_changing_persisted_keys() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let custom = temp.path().join("custom-codex");
        write_skill(&custom.join("skills/shared-review"));
        let spec = super::USER_HOME_SKILL_ROOTS
            .iter()
            .find(|root| root.slot == "home.codex")
            .unwrap();
        let resolved = SkillRegistry::user_skill_root_path_with_environment(spec, &home, |name| {
            (name == "CODEX_HOME").then(|| custom.to_string_lossy().into_owned())
        });
        assert_eq!(resolved, custom.join("skills"));
        let mut root = test_root(resolved);
        root.slot = spec.slot;
        root.source_id = spec.source_id;
        let scan = SkillRegistry::scan_skills_in_dir(&root).await;
        assert!(scan.diagnostics.is_empty());
        assert_eq!(scan.candidates.len(), 1);
        assert_eq!(
            scan.candidates[0].info.key,
            "user::home.codex::shared-review"
        );
        assert_eq!(
            SkillRegistry::user_skill_root_path_with_environment(spec, &home, |_| None),
            home.join(".codex/skills")
        );
        assert_eq!(
            SkillRegistry::user_skill_root_path_with_environment(spec, &home, |_| Some(
                String::new()
            )),
            home.join(".codex/skills")
        );
        assert_eq!(
            SkillRegistry::user_skill_root_path_with_environment(spec, &home, |_| Some(
                "~/custom".into()
            )),
            home.join("custom/skills")
        );
    }

    #[tokio::test]
    async fn claude_config_root_keeps_source_identity_and_rejects_relative_roots() {
        let temp = tempfile::tempdir().unwrap();
        let custom = temp.path().join("custom-claude");
        write_skill(&custom.join("skills/shared-review"));
        let spec = super::USER_HOME_SKILL_ROOTS
            .iter()
            .find(|root| root.slot == "home.claude")
            .unwrap();
        let path =
            SkillRegistry::user_skill_root_path_with_environment(spec, temp.path(), |name| {
                (name == "CLAUDE_CONFIG_DIR").then(|| custom.to_string_lossy().into_owned())
            });
        let mut root = test_root(path);
        root.slot = spec.slot;
        root.source_id = spec.source_id;
        let scan = SkillRegistry::scan_skills_in_dir(&root).await;
        assert_eq!(
            scan.candidates[0].info.key,
            "user::home.claude::shared-review"
        );
        for invalid in ["", "relative", "~/claude"] {
            root.path =
                SkillRegistry::user_skill_root_path_with_environment(spec, temp.path(), |_| {
                    Some(invalid.into())
                });
            let scan = SkillRegistry::scan_skills_in_dir(&root).await;
            assert!(scan.candidates.is_empty());
            assert_eq!(scan.diagnostics.len(), 1);
            assert!(!scan.cacheable);
        }
    }

    fn write_skill(path: &Path) {
        fs::create_dir_all(path).expect("skill directory");
        fs::write(
            path.join("SKILL.md"),
            "---\nname: shared-review\ndescription: Shared review workflow\n---\n",
        )
        .expect("skill markdown");
    }

    fn test_root(path: impl Into<std::path::PathBuf>) -> SkillRootEntry {
        SkillRootEntry {
            path: path.into(),
            level: SkillLocation::User,
            slot: "test",
            source_id: "test",
            source_label: "Test",
            priority: 0,
            is_builtin: false,
        }
    }

    #[tokio::test]
    async fn installation_source_uses_only_the_matching_project_lock_and_existing_skills() {
        let temp = tempfile::tempdir().unwrap();
        let skills_path = temp.path().join(".agents/skills");
        write_skill(&skills_path.join("shared-review"));
        fs::write(temp.path().join("skills-lock.json"), r#"{
            "version": 1, "skills": {
                "shared-review": {"source":"first/skills", "sourceType":"github", "computedHash":"old"},
                "deleted": {"source":"other/skills", "sourceType":"github"}
            }
        }"#).unwrap();
        let mut entry = test_root(&skills_path);
        entry.level = SkillLocation::Project;
        entry.slot = "agents";
        let scanned = SkillRegistry::scan_skills_in_dir(&entry).await.candidates;
        assert_eq!(scanned.len(), 1);
        assert_eq!(
            scanned[0].info.installation_source.as_deref(),
            Some("first/skills")
        );

        entry.slot = "claude";
        assert!(
            SkillRegistry::scan_skills_in_dir(&entry).await.candidates[0]
                .info
                .installation_source
                .is_none()
        );
        entry.slot = "agents";
        fs::write(
            temp.path().join("skills-lock.json"),
            "invalid existing user data",
        )
        .unwrap();
        let scanned = SkillRegistry::scan_skills_in_dir(&entry).await.candidates;
        assert_eq!(scanned.len(), 1);
        assert!(scanned[0].info.installation_source.is_none());
        assert_eq!(
            fs::read_to_string(temp.path().join("skills-lock.json")).unwrap(),
            "invalid existing user data"
        );
    }

    #[test]
    fn installation_source_accepts_existing_global_lock_versions_without_name_fallback() {
        for version in [1, 2, 3] {
            let content = format!(
                r#"{{"version":{version},"skills":{{
                "eli5":{{"source":"first/skills","sourceType":"github","unknown":true}},
                "local":{{"source":"first/skills","sourceType":"local"}},
                "missing":{{"sourceType":"github"}}
            }}}}"#
            );
            let sources = super::parse_skill_installation_sources(&content);
            assert_eq!(sources.len(), 1);
            assert_eq!(
                sources.get("eli5").map(String::as_str),
                Some("first/skills")
            );
        }
    }

    #[cfg(unix)]
    fn create_dir_symlink(target: &Path, link: &Path) -> bool {
        std::os::unix::fs::symlink(target, link).is_ok()
    }

    #[cfg(windows)]
    fn create_dir_symlink(target: &Path, link: &Path) -> bool {
        std::os::windows::fs::symlink_dir(target, link).is_ok()
    }

    #[cfg(unix)]
    fn create_file_symlink(target: &Path, link: &Path) -> bool {
        std::os::unix::fs::symlink(target, link).is_ok()
    }

    #[cfg(windows)]
    fn create_file_symlink(target: &Path, link: &Path) -> bool {
        std::os::windows::fs::symlink_file(target, link).is_ok()
    }

    #[tokio::test]
    async fn standard_scan_follows_linked_skill_directories_without_caching() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("skills");
        let shared_skill = temp.path().join("shared-review");
        fs::create_dir_all(&root).expect("skill root");
        write_skill(&shared_skill);
        if !create_dir_symlink(&shared_skill, &root.join("review")) {
            return;
        }
        let entry = test_root(root);

        let scan = SkillRegistry::scan_skills_in_dir(&entry).await;

        assert!(!scan.cacheable);
        assert_eq!(scan.candidates.len(), 1);
        assert_eq!(scan.candidates[0].info.name, "shared-review");
    }

    #[tokio::test]
    async fn standard_scan_does_not_cache_a_broken_linked_root() {
        let temp = tempfile::tempdir().expect("tempdir");
        let missing_target = temp.path().join("missing-skills");
        let root = temp.path().join("skills");
        if !create_dir_symlink(&missing_target, &root) {
            return;
        }

        let scan = SkillRegistry::scan_skills_in_dir(&test_root(root)).await;

        assert!(!scan.cacheable);
        assert!(scan.candidates.is_empty());
    }

    #[tokio::test]
    async fn standard_scan_does_not_cache_linked_skill_markdown() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("skills");
        let skill_dir = root.join("review");
        let shared_markdown = temp.path().join("shared-SKILL.md");
        fs::create_dir_all(&skill_dir).expect("skill directory");
        fs::write(
            &shared_markdown,
            "---\nname: shared-review\ndescription: Shared review workflow\n---\n",
        )
        .expect("shared skill markdown");
        if !create_file_symlink(&shared_markdown, &skill_dir.join("SKILL.md")) {
            return;
        }

        let scan = SkillRegistry::scan_skills_in_dir(&test_root(root)).await;

        assert!(!scan.cacheable);
        assert_eq!(scan.candidates.len(), 1);
    }

    #[tokio::test]
    async fn standard_scan_does_not_cache_linked_openai_policy() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("skills");
        let skill_dir = root.join("review");
        let shared_policy = temp.path().join("openai.yaml");
        write_skill(&skill_dir);
        fs::create_dir_all(skill_dir.join("agents")).expect("policy directory");
        fs::write(
            &shared_policy,
            "policy:\n  allow_implicit_invocation: false\n",
        )
        .expect("shared policy");
        if !create_file_symlink(&shared_policy, &skill_dir.join("agents/openai.yaml")) {
            return;
        }

        let scan = SkillRegistry::scan_skills_in_dir(&test_root(root)).await;

        assert!(!scan.cacheable);
        assert_eq!(scan.candidates.len(), 1);
        assert!(!scan.candidates[0].info.allow_implicit_invocation);
    }

    #[tokio::test]
    async fn transient_policy_read_failure_is_not_cacheable() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("skills");
        let skill_dir = root.join("review");
        fs::create_dir_all(skill_dir.join("agents/openai.yaml")).expect("policy-shaped directory");
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: review\ndescription: Review changes\n---\n",
        )
        .expect("skill markdown");
        let entry = test_root(root);

        let failed = SkillRegistry::scan_skills_in_dir(&entry).await;

        assert!(!failed.cacheable);
        assert!(failed.candidates[0].info.allow_implicit_invocation);

        fs::remove_dir(skill_dir.join("agents/openai.yaml"))
            .expect("remove policy-shaped directory");
        fs::write(
            skill_dir.join("agents/openai.yaml"),
            "policy:\n  allow_implicit_invocation: false\n",
        )
        .expect("policy file");

        let recovered = SkillRegistry::scan_skills_in_dir(&entry).await;

        assert!(recovered.cacheable);
        assert!(!recovered.candidates[0].info.allow_implicit_invocation);
    }
}

fn sort_remote_dir_entries(entries: &mut [crate::agentic::workspace::WorkspaceDirEntry]) {
    entries.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.name.cmp(&b.name))
            .then_with(|| a.path.cmp(&b.path))
    });
}

#[cfg(feature = "external-sources")]
fn configured_opencode_source_slot(skill_dir: &Path) -> String {
    let mut hasher = Sha256::new();
    hasher.update(skill_dir.to_string_lossy().as_bytes());
    let digest = hex::encode(hasher.finalize());
    format!("config.opencode.{}", &digest[..16])
}

#[cfg(feature = "external-sources")]
fn canonical_candidate_path(candidate: &SkillCandidate) -> PathBuf {
    dunce::canonicalize(&candidate.info.path)
        .unwrap_or_else(|_| PathBuf::from(&candidate.info.path))
}

#[cfg(feature = "external-sources")]
fn is_configured_opencode_source_slot(source_slot: &str) -> bool {
    source_slot.starts_with("config.opencode.")
}

#[cfg(feature = "external-sources")]
fn validate_configured_opencode_skill_root(
    skill_dir: &Path,
    expected_source_slot: &str,
) -> Result<PathBuf, String> {
    if !skill_dir.is_absolute() {
        return Err("configured OpenCode skill root must be absolute".to_string());
    }
    let metadata = std::fs::symlink_metadata(skill_dir)
        .map_err(|error| format!("failed to inspect configured OpenCode skill root: {error}"))?;
    if is_symlink_or_reparse(&metadata) {
        return Err(
            "configured OpenCode skill root must not be a symlink or reparse point".to_string(),
        );
    }
    if !metadata.is_dir() {
        return Err("configured OpenCode skill root must be a directory".to_string());
    }
    let canonical = dunce::canonicalize(skill_dir)
        .map_err(|error| format!("failed to resolve configured OpenCode skill root: {error}"))?;
    if configured_opencode_source_slot(&canonical) != expected_source_slot {
        return Err("configured OpenCode skill root identity changed after discovery".to_string());
    }
    Ok(canonical)
}

/// Skill registry
pub struct SkillRegistry {
    #[cfg(feature = "file-watch")]
    user_sources: VersionedSnapshotCache<UserSkillSources>,
    #[cfg(feature = "file-watch")]
    user_source_monitor: LocalSkillWatchMonitor,
}

impl SkillRegistry {
    fn new() -> Self {
        #[cfg(feature = "file-watch")]
        {
            let user_sources = VersionedSnapshotCache::new();
            let user_source_monitor = LocalSkillWatchMonitor::new(user_sources.invalidator());
            Self {
                user_sources,
                user_source_monitor,
            }
        }
        #[cfg(not(feature = "file-watch"))]
        Self {}
    }

    fn parse_skill_markdown(
        path: String,
        content: &str,
        location: SkillLocation,
        with_content: bool,
        source_slot: &str,
    ) -> Result<SkillData, openbitfun_agent_runtime::skills::SkillParseError> {
        SkillData::from_markdown_for_source_slot(path, content, location, with_content, source_slot)
    }

    pub fn global() -> &'static Self {
        SKILL_REGISTRY.get_or_init(Self::new)
    }

    async fn globally_disabled_skill_keys(
        workspace: Option<SkillPolicyWorkspace<'_>>,
    ) -> HashSet<String> {
        let mut keys: HashSet<String> = load_globally_disabled_user_skills()
            .await
            .unwrap_or_default()
            .into_iter()
            .collect();
        if let Some(workspace) = workspace {
            keys.extend(
                load_globally_disabled_project_skills(workspace)
                    .await
                    .unwrap_or_default(),
            );
        }
        keys
    }

    fn filter_globally_disabled_candidates(
        candidates: Vec<SkillCandidate>,
        globally_disabled_user_skills: &HashSet<String>,
    ) -> Vec<SkillCandidate> {
        candidates
            .into_iter()
            .filter(|candidate| {
                is_skill_globally_enabled(&candidate.info, globally_disabled_user_skills)
            })
            .collect()
    }

    async fn apply_local_openai_policy(
        skill_data: &mut SkillData,
        skill_dir: &Path,
    ) -> (bool, Option<String>) {
        let agents_dir = skill_dir.join("agents");
        let policy_path = agents_dir.join("openai.yaml");
        let cacheable = local_source_path_is_cacheable(&agents_dir).await
            && local_source_path_is_cacheable(&policy_path).await;
        let content = match fs::read_to_string(&policy_path).await {
            Ok(content) => content,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return (cacheable, None),
            Err(error) => {
                warn!(
                    "Failed to read optional skill policy {}: {}",
                    policy_path.display(),
                    error
                );
                return (false, Some(error.to_string()));
            }
        };

        if let Err(error) = skill_data.apply_openai_yaml_policy(&content) {
            warn!(
                "Ignoring invalid optional skill policy {}: {}",
                policy_path.display(),
                error
            );
            return (cacheable, Some(error.to_string()));
        }
        (cacheable, None)
    }

    #[cfg(feature = "external-sources")]
    async fn apply_configured_opencode_policy(
        skill_data: &mut SkillData,
        skill_dir: &Path,
        source_slot: &str,
    ) {
        let skill_dir = match validate_configured_opencode_skill_root(skill_dir, source_slot) {
            Ok(skill_dir) => skill_dir,
            Err(error) => {
                warn!(
                    "Ignoring configured OpenCode skill policy under {}: {}",
                    skill_dir.display(),
                    error
                );
                return;
            }
        };
        let content = match read_workspace_relative_text_bounded(
            &skill_dir,
            "agents/openai.yaml",
            MAX_OPENCODE_CONFIGURED_POLICY_BYTES,
        )
        .await
        {
            Ok(file) => file.content,
            Err(openbitfun_services_core::workspace_text::WorkspaceTextReadError::NotFound) => {
                return
            }
            Err(error) => {
                warn!(
                    "Ignoring configured OpenCode skill policy under {}: {}",
                    skill_dir.display(),
                    error
                );
                return;
            }
        };

        if let Err(error) = skill_data.apply_openai_yaml_policy(&content) {
            warn!(
                "Ignoring invalid configured OpenCode skill policy under {}: {}",
                skill_dir.display(),
                error
            );
        }
    }

    async fn read_local_skill_markdown(info: &SkillInfo) -> OpenBitFunResult<String> {
        #[cfg(feature = "external-sources")]
        if is_configured_opencode_source_slot(&info.source_slot) {
            let skill_dir =
                validate_configured_opencode_skill_root(Path::new(&info.path), &info.source_slot)
                    .map_err(OpenBitFunError::tool)?;
            return read_workspace_relative_text_bounded(
                &skill_dir,
                "SKILL.md",
                MAX_OPENCODE_CONFIGURED_SKILL_BYTES,
            )
            .await
            .map(|file| file.content)
            .map_err(|error| {
                OpenBitFunError::tool(format!(
                    "Failed to read configured OpenCode skill file: {error}"
                ))
            });
        }

        let skill_md_path =
            PathBuf::from(&info.path).join(info.entry_file.as_deref().unwrap_or("SKILL.md"));
        fs::read_to_string(&skill_md_path)
            .await
            .map_err(|error| OpenBitFunError::tool(format!("Failed to read skill file: {}", error)))
    }

    async fn apply_remote_openai_policy(
        skill_data: &mut SkillData,
        fs: &dyn WorkspaceFileSystem,
        skill_dir: &str,
    ) -> Option<String> {
        let policy_path = format!("{}/agents/openai.yaml", skill_dir.trim_end_matches('/'));
        let is_file = match fs.is_file(&policy_path).await {
            Ok(is_file) => is_file,
            Err(error) => {
                warn!(
                    "Failed to inspect optional remote skill policy {}: {}",
                    policy_path, error
                );
                return Some(error.to_string());
            }
        };
        if !is_file {
            return None;
        }

        let content = match fs.read_file_text(&policy_path).await {
            Ok(content) => content,
            Err(error) => {
                warn!(
                    "Failed to read optional remote skill policy {}: {}",
                    policy_path, error
                );
                return Some(error.to_string());
            }
        };
        if let Err(error) = skill_data.apply_openai_yaml_policy(&content) {
            warn!(
                "Ignoring invalid optional remote skill policy {}: {}",
                policy_path, error
            );
            return Some(error.to_string());
        }
        None
    }

    fn get_project_skill_roots(workspace_path: &Path) -> Vec<SkillRootEntry> {
        let mut entries = Vec::new();
        let mut priority = 0usize;

        for spec in PROJECT_SKILL_ROOTS {
            let path = workspace_path.join(spec.parent).join(spec.subdir);
            entries.push(SkillRootEntry {
                path,
                level: SkillLocation::Project,
                slot: spec.slot,
                source_id: spec.source_id,
                source_label: spec.source_label,
                priority,
                is_builtin: false,
            });
            priority += 1;
        }
        entries
    }

    fn user_skill_root_path(
        spec: &openbitfun_agent_runtime::skills::SkillRootSpec,
        home: &Path,
    ) -> PathBuf {
        Self::user_skill_root_path_with_environment(spec, home, |name| std::env::var(name).ok())
    }

    fn user_skill_root_path_with_environment(
        spec: &openbitfun_agent_runtime::skills::SkillRootSpec,
        home: &Path,
        environment: impl Fn(&str) -> Option<String>,
    ) -> PathBuf {
        // Claude config roots, like its Instruction provider, must be absolute.
        // Keep invalid explicit input relative so discovery reports it instead
        // of silently reading the default home or expanding a different root.
        if spec.slot == "home.claude" {
            return environment("CLAUDE_CONFIG_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(spec.parent))
                .join(spec.subdir);
        }
        let variable = match spec.slot {
            "home.codex" => Some("CODEX_HOME"),
            "home.dsh" => Some("DSH_HOME"),
            "home.pi" => Some("PI_CODING_AGENT_DIR"),
            _ => None,
        };
        let root = variable
            .and_then(environment)
            .filter(|value| !value.trim().is_empty());
        let root = root
            .map(|value| {
                if value == "~" {
                    home.to_path_buf()
                } else if let Some(suffix) = value.strip_prefix("~/") {
                    home.join(suffix)
                } else {
                    PathBuf::from(value)
                }
            })
            .unwrap_or_else(|| home.join(spec.parent));
        root.join(spec.subdir)
    }

    fn get_user_skill_roots() -> Vec<SkillRootEntry> {
        let mut entries = Vec::new();
        let mut priority = 0usize;
        let mut deferred_home_entries = Vec::new();

        let home_dir = dirs::home_dir();

        if let Some(home) = home_dir.as_deref() {
            for spec in USER_HOME_SKILL_ROOTS {
                let path = Self::user_skill_root_path(spec, home);
                if spec.parent == ".opencode" {
                    deferred_home_entries.push((
                        path,
                        spec.slot,
                        spec.source_id,
                        spec.source_label,
                    ));
                } else {
                    entries.push(SkillRootEntry {
                        path,
                        level: SkillLocation::User,
                        slot: spec.slot,
                        source_id: spec.source_id,
                        source_label: spec.source_label,
                        priority,
                        is_builtin: false,
                    });
                }
                priority += 1;
            }
        }

        // Explicitly installed native user copies take precedence over external discovery.
        // Project roots still precede every user root, and external-to-external order is unchanged.
        let path_manager = get_path_manager_arc();
        for entry in &mut entries {
            entry.priority += 1;
        }
        entries.insert(
            0,
            SkillRootEntry {
                path: path_manager.user_skills_dir(),
                level: SkillLocation::User,
                slot: OPENBITFUN_USER_SKILL_SLOT,
                source_id: OPENBITFUN_SKILL_SOURCE_ID,
                source_label: OPENBITFUN_SKILL_SOURCE_LABEL,
                priority: 0,
                is_builtin: false,
            },
        );
        priority += 1;

        let builtin_skills = path_manager.builtin_skills_dir();
        entries.push(SkillRootEntry {
            path: builtin_skills,
            level: SkillLocation::User,
            slot: OPENBITFUN_SYSTEM_SKILL_SLOT,
            source_id: OPENBITFUN_SKILL_SOURCE_ID,
            source_label: OPENBITFUN_SKILL_SOURCE_LABEL,
            priority,
            is_builtin: true,
        });
        priority += 1;

        if let Some(config_dir) = dirs::config_dir() {
            for spec in USER_CONFIG_SKILL_ROOTS {
                let path = resolve_user_config_skill_root(spec, &config_dir, home_dir.as_deref());
                entries.push(SkillRootEntry {
                    path,
                    level: SkillLocation::User,
                    slot: spec.slot,
                    source_id: spec.source_id,
                    source_label: spec.source_label,
                    priority,
                    is_builtin: false,
                });
                priority += 1;
            }
        }

        for (path, slot, source_id, source_label) in deferred_home_entries {
            entries.push(SkillRootEntry {
                path,
                level: SkillLocation::User,
                slot,
                source_id,
                source_label,
                priority,
                is_builtin: false,
            });
            priority += 1;
        }

        entries
    }

    #[cfg(feature = "file-watch")]
    fn standard_user_skill_watch_roots() -> Vec<LocalSkillWatchRoot> {
        let mut roots = Vec::new();
        let home_dir = dirs::home_dir();
        if let Some(home) = home_dir.as_deref() {
            roots.extend(USER_HOME_SKILL_ROOTS.iter().filter_map(|spec| {
                let path = Self::user_skill_root_path(spec, home);
                (spec.slot != "home.claude" || path.is_absolute())
                    .then(|| LocalSkillWatchRoot::recursive(path))
            }));
        }

        let path_manager = get_path_manager_arc();
        roots.push(LocalSkillWatchRoot::recursive(
            path_manager.user_skills_dir(),
        ));
        roots.push(LocalSkillWatchRoot::recursive(
            path_manager.builtin_skills_dir(),
        ));

        if let Some(config_dir) = dirs::config_dir() {
            roots.extend(USER_CONFIG_SKILL_ROOTS.iter().map(|spec| {
                LocalSkillWatchRoot::recursive(resolve_user_config_skill_root(
                    spec,
                    &config_dir,
                    home_dir.as_deref(),
                ))
            }));
        }
        roots
    }

    async fn scan_user_skill_sources() -> UserSkillSources {
        #[cfg(feature = "file-watch")]
        let mut cacheable = match ensure_builtin_skills_installed().await {
            Ok(()) => true,
            Err(error) => {
                debug!("Failed to install built-in skills: {}", error);
                false
            }
        };
        #[cfg(not(feature = "file-watch"))]
        if let Err(error) = ensure_builtin_skills_installed().await {
            debug!("Failed to install built-in skills: {}", error);
        }

        let mut standard = Vec::new();
        let mut diagnostics = Vec::new();
        for entry in Self::get_user_skill_roots() {
            let mut scan = Self::scan_skills_in_dir(&entry).await;
            #[cfg(feature = "file-watch")]
            {
                cacheable &= scan.cacheable;
            }
            #[cfg(not(feature = "file-watch"))]
            let _ = scan.cacheable;
            standard.append(&mut scan.candidates);
            diagnostics.append(&mut scan.diagnostics);
        }

        UserSkillSources {
            standard,
            diagnostics,
            #[cfg(feature = "file-watch")]
            cacheable,
            #[cfg(feature = "file-watch")]
            watch_roots: Self::standard_user_skill_watch_roots(),
        }
    }

    #[cfg(feature = "file-watch")]
    async fn user_skill_sources(&self) -> UserSkillSources {
        self.user_source_monitor.start();
        self.user_sources
            .get_or_load(|| async {
                let sources = Self::scan_user_skill_sources().await;
                let cacheable = self
                    .user_source_monitor
                    .sync_roots(sources.watch_roots.clone())
                    .await
                    && sources.cacheable;
                (sources, cacheable)
            })
            .await
    }

    #[cfg(not(feature = "file-watch"))]
    async fn user_skill_sources(&self) -> UserSkillSources {
        Self::scan_user_skill_sources().await
    }

    async fn scan_skill_candidates_for_workspace(
        &self,
        workspace_root: Option<&Path>,
    ) -> Vec<SkillCandidate> {
        self.scan_skill_candidates_with_diagnostics_for_workspace(workspace_root)
            .await
            .into_candidates()
    }

    async fn scan_skill_candidates_with_diagnostics_for_workspace(
        &self,
        workspace_root: Option<&Path>,
    ) -> SkillCandidateScan {
        let mut user_sources = self.user_skill_sources().await;
        let mut diagnostics = std::mem::take(&mut user_sources.diagnostics);
        let mut standard = Vec::new();
        if let Some(workspace_root) = workspace_root {
            for entry in Self::get_project_skill_roots(workspace_root) {
                let mut part = Self::scan_skills_in_dir(&entry).await;
                standard.append(&mut part.candidates);
                diagnostics.append(&mut part.diagnostics);
            }
            for candidate in &mut user_sources.standard {
                candidate.priority = candidate.priority.saturating_add(PROJECT_SKILL_ROOTS.len());
            }
            standard.append(&mut user_sources.standard);
        } else {
            standard.append(&mut user_sources.standard);
        }

        #[cfg(feature = "external-sources")]
        {
            // Explicit Pi paths are re-read on every scan, including refresh and import
            // validation, so changes outside the standard watched roots cannot stay cached.
            let (pi_roots, pi_diagnostics) = pi_configured_skill_roots(workspace_root);
            diagnostics.extend(pi_diagnostics.into_iter().map(|(path, message)| {
                SkillScanDiagnostic {
                    path,
                    source_id: "pi".into(),
                    message,
                }
            }));
            let pi_scan =
                Self::scan_configured_pi_candidates(pi_roots, &standard, workspace_root.is_some())
                    .await;
            standard.extend(pi_scan.candidates);
            diagnostics.extend(pi_scan.diagnostics);
            // OpenCode configured roots are workspace-sensitive: an absolute path
            // from user config may become project-scoped for the current workspace.
            // Discover and scan them once per request so scope and the 64-root cap
            // are applied to one coherent OpenCode configuration snapshot.
            let (roots, root_diagnostics) = opencode_configured_skill_roots(workspace_root);
            diagnostics.extend(root_diagnostics.into_iter().map(|(path, message)| {
                SkillScanDiagnostic {
                    path,
                    source_id: "opencode".to_string(),
                    message,
                }
            }));
            let configured_scan =
                Self::scan_configured_opencode_candidates_with_diagnostics(roots).await;
            diagnostics.extend(configured_scan.diagnostics);
            let mut configured = configured_scan.candidates;
            let existing_paths = standard
                .iter()
                .map(canonical_candidate_path)
                .collect::<HashSet<_>>();
            let mut configured_paths = HashSet::new();
            configured.retain(|candidate| {
                let path = canonical_candidate_path(candidate);
                !existing_paths.contains(&path) && configured_paths.insert(path)
            });
            return SkillCandidateScan {
                candidates: Self::merge_configured_opencode_candidates(
                    standard,
                    configured,
                    workspace_root.is_some(),
                ),
                diagnostics,
            };
        }

        #[cfg(not(feature = "external-sources"))]
        SkillCandidateScan {
            candidates: standard,
            diagnostics,
        }
    }

    #[cfg(feature = "external-sources")]
    fn merge_configured_opencode_candidates(
        mut standard: Vec<SkillCandidate>,
        mut configured: Vec<SkillCandidate>,
        has_workspace: bool,
    ) -> Vec<SkillCandidate> {
        if configured.is_empty() {
            return standard;
        }

        let has_project = configured
            .iter()
            .any(|candidate| candidate.info.level == SkillLocation::Project);
        let has_user = configured
            .iter()
            .any(|candidate| candidate.info.level == SkillLocation::User);
        let project_anchor = PROJECT_SKILL_ROOTS
            .iter()
            .position(|root| root.source_id == "opencode")
            .expect("OpenCode project Skill root is registered");
        let user_anchor = has_workspace
            .then_some(PROJECT_SKILL_ROOTS.len())
            .unwrap_or_default()
            .saturating_add(
                USER_HOME_SKILL_ROOTS
                    .iter()
                    .position(|root| root.source_id == "opencode")
                    .expect("OpenCode user Skill root is registered")
                    + 1,
            );

        for candidate in &mut standard {
            let original_priority = candidate.priority;
            let project_shift = (has_project && original_priority >= project_anchor)
                .then_some(OPENCODE_CONFIGURED_PRIORITY_BAND)
                .unwrap_or_default();
            let user_shift = (has_user && original_priority >= user_anchor)
                .then_some(OPENCODE_CONFIGURED_PRIORITY_BAND)
                .unwrap_or_default();
            candidate.priority = original_priority
                .saturating_add(project_shift)
                .saturating_add(user_shift);
        }
        for candidate in &mut configured {
            let anchor = match candidate.info.level {
                SkillLocation::Project => project_anchor,
                SkillLocation::User => user_anchor.saturating_add(
                    has_project
                        .then_some(OPENCODE_CONFIGURED_PRIORITY_BAND)
                        .unwrap_or_default(),
                ),
            };
            candidate.priority = candidate.priority.saturating_add(anchor);
        }
        standard.extend(configured);
        standard
    }

    #[cfg(feature = "external-sources")]
    async fn scan_configured_opencode_candidates(
        roots: Vec<LocalConfiguredSkillRootContribution>,
    ) -> Vec<SkillCandidate> {
        Self::scan_configured_opencode_candidates_with_diagnostics(roots)
            .await
            .into_candidates()
    }

    #[cfg(feature = "external-sources")]
    async fn scan_configured_opencode_candidates_with_diagnostics(
        roots: Vec<LocalConfiguredSkillRootContribution>,
    ) -> SkillCandidateScan {
        let mut roots = roots;
        roots.sort_by_key(|root| root.precedence);
        let roots = roots
            .into_iter()
            .rev()
            .take(MAX_OPENCODE_CONFIGURED_SKILL_ROOTS)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>();
        let project_root_count = roots
            .iter()
            .filter(|root| {
                matches!(
                    root.scope,
                    openbitfun_product_domains::external_sources::ExternalSourceScope::Project
                        | openbitfun_product_domains::external_sources::ExternalSourceScope::WorkspaceLocal
                )
            })
            .count();
        let user_root_count = roots
            .iter()
            .filter(|root| {
                root.scope
                    == openbitfun_product_domains::external_sources::ExternalSourceScope::UserGlobal
            })
            .count();
        let mut project_root_index = 0usize;
        let mut user_root_index = 0usize;
        let mut candidates = Vec::new();
        let mut diagnostics = Vec::new();

        for root in roots {
            let root_path = root.path.clone();
            let files = match tokio::task::spawn_blocking(move || {
                collect_bounded_regular_files(
                    &root_path,
                    BoundedDirectoryWalkLimits {
                        max_depth: 16,
                        max_entries: 4096,
                        max_directories: 2048,
                        max_files: MAX_OPENCODE_CONFIGURED_SKILLS_PER_ROOT,
                    },
                    |path| path.file_name().and_then(|name| name.to_str()) == Some("SKILL.md"),
                )
            })
            .await
            {
                Ok(Ok(files)) => files,
                Ok(Err(error)) => {
                    diagnostics.push(discovery::diagnostic(
                        root.path.to_string_lossy(),
                        "opencode",
                        &error,
                    ));
                    warn!(
                        "Skipping configured OpenCode skill root {}: {}",
                        root.path.display(),
                        error
                    );
                    continue;
                }
                Err(error) => {
                    diagnostics.push(discovery::diagnostic(
                        root.path.to_string_lossy(),
                        "opencode",
                        &error,
                    ));
                    warn!(
                        "Configured OpenCode skill scan failed for {}: {}",
                        root.path.display(),
                        error
                    );
                    continue;
                }
            };
            let file_count = files.len();
            for (file_index, skill_md_path) in files.into_iter().enumerate() {
                let Some(skill_dir) = skill_md_path.parent() else {
                    continue;
                };
                let Some(dir_name) = normalize_local_skill_dir_name(skill_dir) else {
                    continue;
                };
                let canonical_skill_dir =
                    dunce::canonicalize(skill_dir).unwrap_or_else(|_| skill_dir.to_path_buf());
                let source_slot = configured_opencode_source_slot(&canonical_skill_dir);
                let read_path = skill_md_path.clone();
                let content = match tokio::task::spawn_blocking(move || {
                    read_bounded_text(&read_path, MAX_OPENCODE_CONFIGURED_SKILL_BYTES)
                })
                .await
                {
                    Ok(Ok(BoundedTextRead::Content(content))) => content,
                    Ok(Ok(BoundedTextRead::TooLarge)) => {
                        diagnostics.push(discovery::diagnostic(
                            skill_md_path.to_string_lossy(),
                            "opencode",
                            "SKILL.md exceeds the discovery size limit",
                        ));
                        warn!(
                            "Skipping configured OpenCode skill file above the {} byte limit: {}",
                            MAX_OPENCODE_CONFIGURED_SKILL_BYTES,
                            skill_md_path.display()
                        );
                        continue;
                    }
                    Ok(Ok(BoundedTextRead::InvalidUtf8)) => {
                        diagnostics.push(discovery::diagnostic(
                            skill_md_path.to_string_lossy(),
                            "opencode",
                            "SKILL.md is not valid UTF-8",
                        ));
                        warn!(
                            "Skipping configured OpenCode skill file that is not valid UTF-8: {}",
                            skill_md_path.display()
                        );
                        continue;
                    }
                    Ok(Err(error)) => {
                        diagnostics.push(discovery::diagnostic(
                            skill_md_path.to_string_lossy(),
                            "opencode",
                            &error,
                        ));
                        debug!("Failed to read {}: {}", skill_md_path.display(), error);
                        continue;
                    }
                    Err(error) => {
                        diagnostics.push(discovery::diagnostic(
                            skill_md_path.to_string_lossy(),
                            "opencode",
                            &error,
                        ));
                        warn!(
                            "Configured OpenCode skill read failed for {}: {}",
                            skill_md_path.display(),
                            error
                        );
                        continue;
                    }
                };
                let location = match root.scope {
                    openbitfun_product_domains::external_sources::ExternalSourceScope::UserGlobal => {
                        SkillLocation::User
                    }
                    openbitfun_product_domains::external_sources::ExternalSourceScope::Project
                    | openbitfun_product_domains::external_sources::ExternalSourceScope::WorkspaceLocal => {
                        SkillLocation::Project
                    }
                    _ => continue,
                };
                let (scope_root_count, scope_root_index) = match location {
                    SkillLocation::Project => (project_root_count, project_root_index),
                    SkillLocation::User => (user_root_count, user_root_index),
                };
                let mut skill_data = match Self::parse_skill_markdown(
                    canonical_skill_dir.to_string_lossy().to_string(),
                    &content,
                    location,
                    false,
                    &source_slot,
                ) {
                    Ok(skill_data) => skill_data,
                    Err(error) => {
                        diagnostics.push(discovery::diagnostic(
                            skill_md_path.to_string_lossy(),
                            "opencode",
                            &error,
                        ));
                        error!(
                            "Failed to parse configured OpenCode SKILL.md in {}: {}",
                            canonical_skill_dir.display(),
                            error
                        );
                        continue;
                    }
                };
                Self::apply_configured_opencode_policy(
                    &mut skill_data,
                    &canonical_skill_dir,
                    &source_slot,
                )
                .await;
                skill_data.dir_name = dir_name;
                let root_rank = scope_root_count.saturating_sub(scope_root_index + 1);
                let file_rank = file_count.saturating_sub(file_index + 1);
                let priority = root_rank
                    .saturating_mul(MAX_OPENCODE_CONFIGURED_SKILLS_PER_ROOT)
                    .saturating_add(file_rank);
                let key_prefix = match location {
                    SkillLocation::User => USER_SKILL_KEY_PREFIX,
                    SkillLocation::Project => PROJECT_SKILL_KEY_PREFIX,
                };
                candidates.push(SkillCandidate::from_data(
                    skill_data,
                    &source_slot,
                    "opencode",
                    "OpenCode",
                    key_prefix,
                    priority,
                    false,
                ));
            }
            match root.scope {
                openbitfun_product_domains::external_sources::ExternalSourceScope::UserGlobal => {
                    user_root_index = user_root_index.saturating_add(1);
                }
                openbitfun_product_domains::external_sources::ExternalSourceScope::Project
                | openbitfun_product_domains::external_sources::ExternalSourceScope::WorkspaceLocal => {
                    project_root_index = project_root_index.saturating_add(1);
                }
                _ => {}
            }
        }
        candidates.sort_by_key(|candidate| candidate.priority);
        let mut seen_paths = HashSet::new();
        candidates.retain(|candidate| seen_paths.insert(candidate.info.path.clone()));
        SkillCandidateScan {
            candidates: sort_skill_candidates_by_dir(candidates),
            diagnostics,
        }
    }

    async fn scan_skill_candidates_for_remote_workspace(
        &self,
        fs: &dyn WorkspaceFileSystem,
        remote_root: &str,
    ) -> Vec<SkillCandidate> {
        self.scan_skill_candidates_with_diagnostics_for_remote_workspace(fs, remote_root)
            .await
            .into_candidates()
    }

    async fn scan_skill_candidates_with_diagnostics_for_remote_workspace(
        &self,
        fs: &dyn WorkspaceFileSystem,
        remote_root: &str,
    ) -> SkillCandidateScan {
        let (user, project) = tokio::join!(
            self.scan_skill_candidates_with_diagnostics_for_workspace(None),
            Self::scan_remote_project_skills(fs, remote_root),
        );
        Self::merge_remote_skill_scans(user, project)
    }

    fn merge_remote_skill_scans(
        mut user: SkillCandidateScan,
        mut project: SkillCandidateScan,
    ) -> SkillCandidateScan {
        for candidate in &mut user.candidates {
            candidate.priority = candidate.priority.saturating_add(PROJECT_SKILL_ROOTS.len());
        }
        project.candidates.append(&mut user.candidates);
        project.diagnostics.append(&mut user.diagnostics);
        project
    }

    async fn apply_mode_filters_for_workspace(
        &self,
        candidates: Vec<SkillCandidate>,
        workspace: Option<&crate::agentic::workspace::WorkspaceBinding>,
        agent_type: Option<&str>,
    ) -> Vec<SkillCandidate> {
        let workspace_root = workspace.map(|workspace| workspace.root_path());
        // Static discovered Skills are directly usable; plugin contributions remain owner-controlled.
        #[cfg(feature = "opencode-plugin-host")]
        let candidates = {
            let mut candidates = candidates;
            let plugin_roots = crate::plugin_capability_publication::skill_roots_for_agent(
                workspace.and_then(|workspace| workspace.workspace_id.as_deref()),
                agent_type,
            )
            .into_iter()
            .map(|root| LocalConfiguredSkillRootContribution {
                path: root.path,
                scope:
                    openbitfun_product_domains::external_sources::ExternalSourceScope::WorkspaceLocal,
                precedence: root.precedence,
            })
            .collect::<Vec<_>>();
            if !plugin_roots.is_empty() {
                let existing_paths = candidates
                    .iter()
                    .map(canonical_candidate_path)
                    .collect::<HashSet<_>>();
                let mut plugin_candidates =
                    Self::scan_configured_opencode_candidates(plugin_roots).await;
                plugin_candidates.retain(|candidate| {
                    !existing_paths.contains(&canonical_candidate_path(candidate))
                });
                candidates = Self::merge_configured_opencode_candidates(
                    candidates,
                    plugin_candidates,
                    workspace_root.is_some(),
                );
            }
            candidates
        };
        let globally_disabled_user_skills = Self::globally_disabled_skill_keys(
            workspace.and_then(SkillPolicyWorkspace::from_binding),
        )
        .await;
        let candidates =
            Self::filter_globally_disabled_candidates(candidates, &globally_disabled_user_skills);
        let Some(mode_id) = agent_type.map(str::trim).filter(|value| !value.is_empty()) else {
            return candidates;
        };

        let user_overrides = load_user_mode_skill_overrides(mode_id)
            .await
            .unwrap_or_else(|_| UserModeSkillOverrides::default());
        let disabled_project = match workspace_root {
            Some(root) => load_disabled_mode_skills_local(root, mode_id)
                .await
                .unwrap_or_default(),
            None => Vec::new(),
        };

        let disabled_project: HashSet<String> =
            normalize_skill_keys(disabled_project).into_iter().collect();

        filter_candidates_for_mode(candidates, mode_id, &user_overrides, &disabled_project)
    }

    async fn apply_mode_filters_for_remote_workspace(
        &self,
        candidates: Vec<SkillCandidate>,
        fs: &dyn WorkspaceFileSystem,
        remote_root: &str,
        agent_type: Option<&str>,
    ) -> Vec<SkillCandidate> {
        let globally_disabled_user_skills = Self::globally_disabled_skill_keys(None).await;
        let candidates =
            Self::filter_globally_disabled_candidates(candidates, &globally_disabled_user_skills);
        let Some(mode_id) = agent_type.map(str::trim).filter(|value| !value.is_empty()) else {
            return candidates;
        };

        let user_overrides = load_user_mode_skill_overrides(mode_id)
            .await
            .unwrap_or_else(|_| UserModeSkillOverrides::default());
        let disabled_project = load_disabled_mode_skills_remote(fs, remote_root, mode_id)
            .await
            .unwrap_or_default();

        let disabled_project: HashSet<String> =
            normalize_skill_keys(disabled_project).into_iter().collect();

        filter_candidates_for_mode(candidates, mode_id, &user_overrides, &disabled_project)
    }

    fn find_default_hidden_builtin_for_explicit_invocation(
        skill_name: &str,
        candidates: Vec<SkillCandidate>,
        agent_type: Option<&str>,
    ) -> OpenBitFunResult<SkillInfo> {
        match resolve_default_hidden_builtin_for_explicit_invocation(
            skill_name, candidates, agent_type,
        ) {
            ExplicitSkillInvocationResolution::Found(info) => Ok(info),
            ExplicitSkillInvocationResolution::NotFound => Err(OpenBitFunError::tool(format!(
                "Skill '{}' not found",
                skill_name
            ))),
            ExplicitSkillInvocationResolution::DisabledForMode { mode_id } => {
                Err(OpenBitFunError::tool(format!(
                    "Skill '{}' is disabled for mode '{}'. Enable it in mode skill settings or switch to a mode where it is enabled.",
                    skill_name, mode_id
                )))
            }
        }
    }

    async fn find_skill_info_for_explicit_invocation_workspace(
        &self,
        skill_name: &str,
        workspace: Option<&crate::agentic::workspace::WorkspaceBinding>,
        agent_type: Option<&str>,
    ) -> OpenBitFunResult<SkillInfo> {
        let workspace_root = workspace.map(|workspace| workspace.root_path());
        let candidates = self
            .scan_skill_candidates_for_workspace(workspace_root)
            .await;
        let globally_disabled_user_skills = Self::globally_disabled_skill_keys(
            workspace.and_then(SkillPolicyWorkspace::from_binding),
        )
        .await;
        let candidates =
            Self::filter_globally_disabled_candidates(candidates, &globally_disabled_user_skills);
        let filtered = self
            .apply_mode_filters_for_workspace(candidates.clone(), workspace, agent_type)
            .await;
        if let Some(info) = resolve_visible_skills(filtered)
            .into_iter()
            .find(|skill| skill.name == skill_name)
        {
            return Ok(info);
        }

        Self::find_default_hidden_builtin_for_explicit_invocation(
            skill_name, candidates, agent_type,
        )
    }

    async fn find_skill_info_for_explicit_invocation_remote_workspace(
        &self,
        skill_name: &str,
        fs: &dyn WorkspaceFileSystem,
        remote_root: &str,
        agent_type: Option<&str>,
    ) -> OpenBitFunResult<SkillInfo> {
        let candidates = self
            .scan_skill_candidates_for_remote_workspace(fs, remote_root)
            .await;
        let globally_disabled_user_skills = Self::globally_disabled_skill_keys(None).await;
        let candidates =
            Self::filter_globally_disabled_candidates(candidates, &globally_disabled_user_skills);
        let filtered = self
            .apply_mode_filters_for_remote_workspace(
                candidates.clone(),
                fs,
                remote_root,
                agent_type,
            )
            .await;
        if let Some(info) = resolve_visible_skills(filtered)
            .into_iter()
            .find(|skill| skill.name == skill_name)
        {
            return Ok(info);
        }

        Self::find_default_hidden_builtin_for_explicit_invocation(
            skill_name, candidates, agent_type,
        )
    }

    pub async fn refresh(&self) {
        #[cfg(feature = "file-watch")]
        self.user_sources.invalidate();
    }

    pub async fn refresh_for_workspace(&self, _workspace_root: Option<&Path>) {
        self.refresh().await;
    }

    pub async fn get_all_skills(&self) -> Vec<SkillInfo> {
        self.get_all_skills_for_workspace(None).await
    }

    pub async fn get_skill_scan_report_for_workspace(
        &self,
        workspace_root: Option<&Path>,
    ) -> SkillScanReport {
        let scan = self
            .scan_skill_candidates_with_diagnostics_for_workspace(workspace_root)
            .await;
        SkillScanReport {
            skills: sort_skills(annotate_shadowed_skills(scan.candidates)),
            diagnostics: scan.diagnostics,
        }
    }

    pub async fn get_skill_scan_report_for_remote_workspace(
        &self,
        fs: &dyn WorkspaceFileSystem,
        remote_root: &str,
    ) -> SkillScanReport {
        let scan = self
            .scan_skill_candidates_with_diagnostics_for_remote_workspace(fs, remote_root)
            .await;
        SkillScanReport {
            skills: sort_skills(annotate_shadowed_skills(scan.candidates)),
            diagnostics: scan.diagnostics,
        }
    }

    pub async fn get_all_skills_for_workspace(
        &self,
        workspace_root: Option<&Path>,
    ) -> Vec<SkillInfo> {
        sort_skills(annotate_shadowed_skills(
            self.scan_skill_candidates_for_workspace(workspace_root)
                .await,
        ))
    }

    pub async fn get_all_skills_for_remote_workspace(
        &self,
        fs: &dyn WorkspaceFileSystem,
        remote_root: &str,
    ) -> Vec<SkillInfo> {
        sort_skills(annotate_shadowed_skills(
            self.scan_skill_candidates_for_remote_workspace(fs, remote_root)
                .await,
        ))
    }

    pub async fn get_resolved_skills_for_workspace(
        &self,
        workspace: Option<&crate::agentic::workspace::WorkspaceBinding>,
        agent_type: Option<&str>,
    ) -> Vec<SkillInfo> {
        let workspace_root = workspace.map(|workspace| workspace.root_path());
        let candidates = self
            .scan_skill_candidates_for_workspace(workspace_root)
            .await;
        let filtered = self
            .apply_mode_filters_for_workspace(candidates, workspace, agent_type)
            .await;
        sort_skills(resolve_visible_skills(filtered))
    }

    pub async fn get_resolved_skills_for_remote_workspace(
        &self,
        fs: &dyn WorkspaceFileSystem,
        remote_root: &str,
        agent_type: Option<&str>,
    ) -> Vec<SkillInfo> {
        let candidates = self
            .scan_skill_candidates_for_remote_workspace(fs, remote_root)
            .await;
        let filtered = self
            .apply_mode_filters_for_remote_workspace(candidates, fs, remote_root, agent_type)
            .await;
        sort_skills(resolve_visible_skills(filtered))
    }

    pub async fn get_implicitly_invocable_skills_for_workspace(
        &self,
        workspace: Option<&crate::agentic::workspace::WorkspaceBinding>,
        agent_type: Option<&str>,
    ) -> Vec<SkillInfo> {
        filter_implicitly_invocable_skills_for_agent(
            self.get_resolved_skills_for_workspace(workspace, agent_type)
                .await,
            agent_type,
        )
    }

    pub async fn get_user_invocable_skills_for_workspace(
        &self,
        workspace: Option<&crate::agentic::workspace::WorkspaceBinding>,
        agent_type: Option<&str>,
    ) -> Vec<SkillInfo> {
        filter_user_invocable_skills(
            self.get_resolved_skills_for_workspace(workspace, agent_type)
                .await,
        )
    }

    pub async fn get_implicitly_invocable_skills_for_remote_workspace(
        &self,
        fs: &dyn WorkspaceFileSystem,
        remote_root: &str,
        agent_type: Option<&str>,
    ) -> Vec<SkillInfo> {
        filter_implicitly_invocable_skills_for_agent(
            self.get_resolved_skills_for_remote_workspace(fs, remote_root, agent_type)
                .await,
            agent_type,
        )
    }

    pub async fn get_mode_skill_infos_for_workspace(
        &self,
        workspace: Option<SkillPolicyWorkspace<'_>>,
        mode_id: &str,
    ) -> Vec<ModeSkillInfo> {
        self.get_mode_skill_scan_report_for_workspace(workspace, mode_id)
            .await
            .skills
    }

    /// Mode Skill management for a local workspace. The workspace ID owns the
    /// project availability policy; its root is only the directory scanned for
    /// project Skill files and project-local mode overrides.
    pub async fn get_mode_skill_scan_report_for_workspace(
        &self,
        workspace: Option<SkillPolicyWorkspace<'_>>,
        mode_id: &str,
    ) -> SkillScanReport<ModeSkillInfo> {
        let workspace_root = workspace.map(|workspace| workspace.root);
        let scan = self
            .scan_skill_candidates_with_diagnostics_for_workspace(workspace_root)
            .await;
        let candidates = scan.candidates;
        let all_skills = sort_skills(annotate_shadowed_skills(candidates.clone()));
        let user_overrides = load_user_mode_skill_overrides(mode_id)
            .await
            .unwrap_or_else(|_| UserModeSkillOverrides::default());
        let disabled_project = match workspace_root {
            Some(root) => load_disabled_mode_skills_local(root, mode_id)
                .await
                .unwrap_or_default(),
            None => Vec::new(),
        };
        let disabled_project: HashSet<String> =
            normalize_skill_keys(disabled_project).into_iter().collect();
        let globally_disabled_user_skills = Self::globally_disabled_skill_keys(workspace).await;
        let filtered = Self::filter_globally_disabled_candidates(
            filter_candidates_for_mode(candidates, mode_id, &user_overrides, &disabled_project),
            &globally_disabled_user_skills,
        );
        let resolved = resolve_visible_skills(filtered);

        SkillScanReport {
            skills: build_mode_skill_infos(
                all_skills,
                resolved,
                mode_id,
                &user_overrides,
                &disabled_project,
                &globally_disabled_user_skills,
            ),
            diagnostics: scan.diagnostics,
        }
    }

    pub async fn get_mode_skill_infos_for_remote_workspace(
        &self,
        fs: &dyn WorkspaceFileSystem,
        remote_root: &str,
        mode_id: &str,
    ) -> Vec<ModeSkillInfo> {
        self.get_mode_skill_scan_report_for_remote_workspace(fs, remote_root, mode_id)
            .await
            .skills
    }

    pub async fn get_mode_skill_scan_report_for_remote_workspace(
        &self,
        fs: &dyn WorkspaceFileSystem,
        remote_root: &str,
        mode_id: &str,
    ) -> SkillScanReport<ModeSkillInfo> {
        let scan = self
            .scan_skill_candidates_with_diagnostics_for_remote_workspace(fs, remote_root)
            .await;
        let candidates = scan.candidates;
        let all_skills = sort_skills(annotate_shadowed_skills(candidates.clone()));
        let user_overrides = load_user_mode_skill_overrides(mode_id)
            .await
            .unwrap_or_else(|_| UserModeSkillOverrides::default());
        let disabled_project = load_disabled_mode_skills_remote(fs, remote_root, mode_id)
            .await
            .unwrap_or_default();
        let disabled_project: HashSet<String> =
            normalize_skill_keys(disabled_project).into_iter().collect();
        let globally_disabled_user_skills = Self::globally_disabled_skill_keys(None).await;
        let filtered = Self::filter_globally_disabled_candidates(
            filter_candidates_for_mode(candidates, mode_id, &user_overrides, &disabled_project),
            &globally_disabled_user_skills,
        );
        let resolved = resolve_visible_skills(filtered);

        SkillScanReport {
            skills: build_mode_skill_infos(
                all_skills,
                resolved,
                mode_id,
                &user_overrides,
                &disabled_project,
                &globally_disabled_user_skills,
            ),
            diagnostics: scan.diagnostics,
        }
    }

    pub async fn find_skill_by_key_for_workspace(
        &self,
        skill_key: &str,
        workspace_root: Option<&Path>,
    ) -> Option<SkillInfo> {
        self.get_all_skills_for_workspace(workspace_root)
            .await
            .into_iter()
            .find(|skill| skill.key == skill_key)
    }

    pub async fn find_skill_by_key_for_remote_workspace(
        &self,
        fs: &dyn WorkspaceFileSystem,
        remote_root: &str,
        skill_key: &str,
    ) -> Option<SkillInfo> {
        self.get_all_skills_for_remote_workspace(fs, remote_root)
            .await
            .into_iter()
            .find(|skill| skill.key == skill_key)
    }

    pub async fn find_and_load_skill_for_workspace(
        &self,
        skill_name: &str,
        workspace: Option<&crate::agentic::workspace::WorkspaceBinding>,
        agent_type: Option<&str>,
    ) -> OpenBitFunResult<SkillData> {
        let info = self
            .find_skill_info_for_explicit_invocation_workspace(skill_name, workspace, agent_type)
            .await?;

        let content = Self::read_local_skill_markdown(&info).await?;

        let mut data = Self::parse_skill_markdown(
            info.parser_path(),
            &content,
            info.level,
            true,
            info.parser_source_slot(),
        )
        .map_err(|error| OpenBitFunError::tool(error.to_string()))?;
        data.path = info.path;
        data.entry_file = info.entry_file;
        data.key = info.key;
        data.source_slot = info.source_slot;
        data.source_id = info.source_id;
        data.source_label = info.source_label;
        data.dir_name = info.dir_name;
        Ok(data)
    }

    pub async fn find_and_load_skill_by_key_for_workspace(
        &self,
        skill_key: &str,
        workspace: Option<&crate::agentic::workspace::WorkspaceBinding>,
        agent_type: Option<&str>,
    ) -> OpenBitFunResult<SkillData> {
        let workspace_root = workspace.map(|workspace| workspace.root_path());
        let candidates = self
            .scan_skill_candidates_for_workspace(workspace_root)
            .await;
        let filtered = self
            .apply_mode_filters_for_workspace(candidates, workspace, agent_type)
            .await;
        let info = filtered
            .into_iter()
            .map(|candidate| candidate.info)
            .find(|skill| skill.key == skill_key)
            .ok_or_else(|| {
                OpenBitFunError::tool(format!(
                    "Skill key '{}' was not found or is disabled for this mode",
                    skill_key
                ))
            })?;

        let content = Self::read_local_skill_markdown(&info).await?;

        let mut data = Self::parse_skill_markdown(
            info.parser_path(),
            &content,
            info.level,
            true,
            info.parser_source_slot(),
        )
        .map_err(|error| OpenBitFunError::tool(error.to_string()))?;
        data.path = info.path;
        data.entry_file = info.entry_file;
        data.key = info.key;
        data.source_slot = info.source_slot;
        data.source_id = info.source_id;
        data.source_label = info.source_label;
        data.dir_name = info.dir_name;
        Ok(data)
    }

    pub async fn find_and_load_skill_for_remote_workspace(
        &self,
        skill_name: &str,
        fs: &dyn WorkspaceFileSystem,
        remote_root: &str,
        agent_type: Option<&str>,
    ) -> OpenBitFunResult<SkillData> {
        let info = self
            .find_skill_info_for_explicit_invocation_remote_workspace(
                skill_name,
                fs,
                remote_root,
                agent_type,
            )
            .await?;

        let content = Self::read_skill_md_for_remote_merge(&info, fs).await?;
        let mut data = Self::parse_skill_markdown(
            info.parser_path(),
            &content,
            info.level,
            true,
            info.parser_source_slot(),
        )
        .map_err(|error| OpenBitFunError::tool(error.to_string()))?;
        data.path = info.path;
        data.entry_file = info.entry_file;
        data.key = info.key;
        data.source_slot = info.source_slot;
        data.source_id = info.source_id;
        data.source_label = info.source_label;
        data.dir_name = info.dir_name;
        Ok(data)
    }

    pub async fn find_and_load_skill_by_key_for_remote_workspace(
        &self,
        skill_key: &str,
        fs: &dyn WorkspaceFileSystem,
        remote_root: &str,
        agent_type: Option<&str>,
    ) -> OpenBitFunResult<SkillData> {
        let candidates = self
            .scan_skill_candidates_for_remote_workspace(fs, remote_root)
            .await;
        let filtered = self
            .apply_mode_filters_for_remote_workspace(candidates, fs, remote_root, agent_type)
            .await;
        let info = filtered
            .into_iter()
            .map(|candidate| candidate.info)
            .find(|skill| skill.key == skill_key)
            .ok_or_else(|| {
                OpenBitFunError::tool(format!(
                    "Skill key '{}' was not found or is disabled for this mode",
                    skill_key
                ))
            })?;

        let content = Self::read_skill_md_for_remote_merge(&info, fs).await?;
        let mut data = Self::parse_skill_markdown(
            info.parser_path(),
            &content,
            info.level,
            true,
            info.parser_source_slot(),
        )
        .map_err(|error| OpenBitFunError::tool(error.to_string()))?;
        data.path = info.path;
        data.entry_file = info.entry_file;
        data.key = info.key;
        data.source_slot = info.source_slot;
        data.source_id = info.source_id;
        data.source_label = info.source_label;
        data.dir_name = info.dir_name;
        Ok(data)
    }

    pub async fn get_resolved_skills_xml_for_workspace(
        &self,
        workspace: Option<&crate::agentic::workspace::WorkspaceBinding>,
        agent_type: Option<&str>,
    ) -> Vec<String> {
        let workspace_root = workspace.map(|workspace| workspace.root_path());
        let scan = self
            .scan_skill_candidates_with_diagnostics_for_workspace(workspace_root)
            .await;
        let filtered = self
            .apply_mode_filters_for_workspace(scan.candidates, workspace, agent_type)
            .await;
        let mut xml: Vec<_> = filter_implicitly_invocable_skills_for_agent(
            sort_skills(resolve_visible_skills(filtered)),
            agent_type,
        )
        .into_iter()
        .map(|skill| skill.to_xml_desc())
        .collect();
        xml.extend(scan.diagnostics.iter().map(SkillScanDiagnostic::to_xml));
        xml
    }

    pub async fn get_resolved_skills_xml_for_remote_workspace(
        &self,
        fs: &dyn WorkspaceFileSystem,
        remote_root: &str,
        agent_type: Option<&str>,
    ) -> Vec<String> {
        let scan = self
            .scan_skill_candidates_with_diagnostics_for_remote_workspace(fs, remote_root)
            .await;
        let filtered = self
            .apply_mode_filters_for_remote_workspace(scan.candidates, fs, remote_root, agent_type)
            .await;
        let mut xml: Vec<_> = filter_implicitly_invocable_skills_for_agent(
            sort_skills(resolve_visible_skills(filtered)),
            agent_type,
        )
        .into_iter()
        .map(|skill| skill.to_xml_desc())
        .collect();
        xml.extend(scan.diagnostics.iter().map(SkillScanDiagnostic::to_xml));
        xml
    }

    async fn read_skill_md_for_remote_merge(
        info: &SkillInfo,
        remote_fs: &dyn WorkspaceFileSystem,
    ) -> OpenBitFunResult<String> {
        match info.level {
            SkillLocation::User => Self::read_local_skill_markdown(info).await,
            SkillLocation::Project => {
                let skill_md_path = format!(
                    "{}/{}",
                    info.path.trim_end_matches('/'),
                    info.entry_file.as_deref().unwrap_or("SKILL.md")
                );
                remote_fs
                    .read_file_text(&skill_md_path)
                    .await
                    .map_err(|error| {
                        OpenBitFunError::tool(format!("Failed to read skill file: {}", error))
                    })
            }
        }
    }
}

#[cfg(all(test, feature = "external-sources"))]
mod opencode_configured_skill_tests {
    use super::{SkillRegistry, SkillRootEntry};
    use crate::external_sources::LocalConfiguredSkillRootContribution;
    use openbitfun_agent_runtime::skills::{resolve_visible_skills, SkillLocation};
    use openbitfun_product_domains::external_sources::ExternalSourceScope;
    use std::fs;
    use std::path::{Path, PathBuf};

    fn write(path: impl AsRef<Path>, content: &str) {
        let path = path.as_ref();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    fn skill(name: &str) -> String {
        format!("---\nname: {name}\ndescription: {name} skill\n---\nRun {name}.\n")
    }

    fn configured_root(
        path: PathBuf,
        scope: ExternalSourceScope,
        precedence: usize,
    ) -> LocalConfiguredSkillRootContribution {
        LocalConfiguredSkillRootContribution {
            path: dunce::canonicalize(path).unwrap(),
            scope,
            precedence,
        }
    }

    #[tokio::test]
    async fn configured_roots_are_recursive_and_nested_same_named_dirs_keep_unique_keys() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        fs::create_dir_all(project.join(".git")).unwrap();
        write(
            project.join("custom-skills/a/foo/SKILL.md"),
            &skill("first"),
        );
        write(
            project.join("custom-skills/b/foo/SKILL.md"),
            &skill("second"),
        );
        let roots = vec![configured_root(
            project.join("custom-skills"),
            ExternalSourceScope::Project,
            0,
        )];

        let candidates = SkillRegistry::scan_configured_opencode_candidates(roots).await;

        assert_eq!(candidates.len(), 2);
        assert_ne!(candidates[0].info.key, candidates[1].info.key);
        assert_ne!(
            candidates[0].info.source_slot,
            candidates[1].info.source_slot
        );
        assert!(candidates
            .iter()
            .all(|candidate| candidate.info.source_slot.starts_with("config.opencode.")));
    }

    #[tokio::test]
    async fn later_configured_root_overrides_standard_opencode_skill() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(project.join(".git")).unwrap();
        write(home.join("first-skills/review/SKILL.md"), &skill("review"));
        write(
            project.join("later-skills/review/SKILL.md"),
            &skill("review"),
        );
        write(
            project.join(".opencode/skills/review/SKILL.md"),
            &skill("review"),
        );
        let roots = vec![
            configured_root(
                home.join("first-skills"),
                ExternalSourceScope::UserGlobal,
                0,
            ),
            configured_root(
                project.join("later-skills"),
                ExternalSourceScope::Project,
                1,
            ),
        ];

        let standard = SkillRegistry::scan_skills_in_dir(&SkillRootEntry {
            path: project.join(".opencode/skills"),
            level: SkillLocation::Project,
            slot: "opencode",
            source_id: "opencode",
            source_label: "OpenCode",
            priority: super::PROJECT_SKILL_ROOTS
                .iter()
                .position(|root| root.source_id == "opencode")
                .unwrap(),
            is_builtin: false,
        })
        .await
        .candidates;
        let configured = SkillRegistry::scan_configured_opencode_candidates(roots).await;
        let candidates =
            SkillRegistry::merge_configured_opencode_candidates(standard, configured, true);
        let resolved = resolve_visible_skills(candidates);

        assert_eq!(resolved.len(), 1);
        assert!(resolved[0].path.contains("later-skills"));
    }

    #[tokio::test]
    async fn configured_opencode_roots_do_not_reorder_earlier_standard_ecosystems() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        write(
            project.join(".openbitfun/skills/review/SKILL.md"),
            &skill("review"),
        );
        write(project.join("custom/review/SKILL.md"), &skill("review"));
        let standard = SkillRegistry::scan_skills_in_dir(&SkillRootEntry {
            path: project.join(".openbitfun/skills"),
            level: SkillLocation::Project,
            slot: "openbitfun",
            source_id: "openbitfun",
            source_label: "OpenBitFun",
            priority: 0,
            is_builtin: false,
        })
        .await
        .candidates;
        let configured = SkillRegistry::scan_configured_opencode_candidates(vec![configured_root(
            project.join("custom"),
            ExternalSourceScope::Project,
            0,
        )])
        .await;

        let resolved = resolve_visible_skills(SkillRegistry::merge_configured_opencode_candidates(
            standard, configured, true,
        ));

        assert_eq!(resolved.len(), 1);
        assert!(resolved[0].path.contains(".openbitfun"));
    }

    #[tokio::test]
    async fn project_configured_band_does_not_shift_user_ecosystem_order_twice() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        write(
            home.join(".claude/skills/review/SKILL.md"),
            &skill("review"),
        );
        write(home.join("configured/review/SKILL.md"), &skill("review"));
        write(project.join("configured/other/SKILL.md"), &skill("other"));
        let standard = SkillRegistry::scan_skills_in_dir(&SkillRootEntry {
            path: home.join(".claude/skills"),
            level: SkillLocation::User,
            slot: "home.claude",
            source_id: "claude-code",
            source_label: "Claude Code",
            priority: super::PROJECT_SKILL_ROOTS.len(),
            is_builtin: false,
        })
        .await
        .candidates;
        let configured = SkillRegistry::scan_configured_opencode_candidates(vec![
            configured_root(home.join("configured"), ExternalSourceScope::UserGlobal, 0),
            configured_root(project.join("configured"), ExternalSourceScope::Project, 1),
        ])
        .await;

        let resolved = resolve_visible_skills(SkillRegistry::merge_configured_opencode_candidates(
            standard, configured, true,
        ));
        let review = resolved
            .iter()
            .find(|skill| skill.name == "review")
            .unwrap();

        assert!(review.path.contains(".claude"));
    }

    #[tokio::test]
    async fn overlapping_configured_roots_publish_each_canonical_skill_once() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        fs::create_dir_all(project.join(".git")).unwrap();
        write(
            project.join("skills/nested/review/SKILL.md"),
            &skill("review"),
        );
        let roots = vec![
            configured_root(project.join("skills"), ExternalSourceScope::Project, 0),
            configured_root(
                project.join("skills/nested"),
                ExternalSourceScope::Project,
                1,
            ),
        ];

        let candidates = SkillRegistry::scan_configured_opencode_candidates(roots).await;

        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].info.name, "review");
    }

    #[tokio::test]
    async fn oversized_configured_skill_does_not_hide_other_valid_skills() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        fs::create_dir_all(project.join(".git")).unwrap();
        write(project.join("skills/valid/SKILL.md"), &skill("valid"));
        write(
            project.join("skills/oversized/SKILL.md"),
            &"x".repeat(super::MAX_OPENCODE_CONFIGURED_SKILL_BYTES + 1),
        );
        let roots = vec![configured_root(
            project.join("skills"),
            ExternalSourceScope::Project,
            0,
        )];

        let candidates = SkillRegistry::scan_configured_opencode_candidates(roots).await;

        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].info.name, "valid");
    }

    #[tokio::test]
    async fn configured_skill_load_rechecks_the_bounded_file_contract() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        let skill_path = project.join("skills/review/SKILL.md");
        write(&skill_path, &skill("review"));
        let candidates = SkillRegistry::scan_configured_opencode_candidates(vec![configured_root(
            project.join("skills"),
            ExternalSourceScope::Project,
            0,
        )])
        .await;
        assert_eq!(candidates.len(), 1);
        fs::write(
            &skill_path,
            "x".repeat(super::MAX_OPENCODE_CONFIGURED_SKILL_BYTES + 1),
        )
        .unwrap();

        let error = SkillRegistry::read_local_skill_markdown(&candidates[0].info)
            .await
            .unwrap_err();

        assert!(error.to_string().contains("262144 byte limit"));
    }

    #[tokio::test]
    async fn configured_skill_load_rejects_a_replaced_root_link() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        let skill_dir = project.join("skills/review");
        write(skill_dir.join("SKILL.md"), &skill("review"));
        let candidates = SkillRegistry::scan_configured_opencode_candidates(vec![configured_root(
            project.join("skills"),
            ExternalSourceScope::Project,
            0,
        )])
        .await;
        assert_eq!(candidates.len(), 1);
        let moved = temp.path().join("moved-review");
        fs::rename(&skill_dir, &moved).unwrap();
        if !create_dir_symlink(&moved, &skill_dir) {
            return;
        }

        let error = SkillRegistry::read_local_skill_markdown(&candidates[0].info)
            .await
            .unwrap_err();

        assert!(error.to_string().contains("must not be a symlink"));
    }

    #[tokio::test]
    async fn configured_skill_policy_is_bounded_and_does_not_follow_directory_links() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        let skill_dir = project.join("skills/review");
        write(skill_dir.join("SKILL.md"), &skill("review"));
        write(
            skill_dir.join("agents/openai.yaml"),
            &format!(
                "policy:\n  allow_implicit_invocation: false\n{}",
                " ".repeat(super::MAX_OPENCODE_CONFIGURED_POLICY_BYTES)
            ),
        );
        let roots = vec![configured_root(
            project.join("skills"),
            ExternalSourceScope::Project,
            0,
        )];

        let oversized = SkillRegistry::scan_configured_opencode_candidates(roots.clone()).await;

        assert_eq!(oversized.len(), 1);
        assert!(oversized[0].info.allow_implicit_invocation);

        fs::remove_dir_all(skill_dir.join("agents")).unwrap();
        let outside = temp.path().join("outside-agents");
        write(
            outside.join("openai.yaml"),
            "policy:\n  allow_implicit_invocation: false\n",
        );
        if !create_dir_symlink(&outside, &skill_dir.join("agents")) {
            return;
        }

        let linked = SkillRegistry::scan_configured_opencode_candidates(roots).await;

        assert_eq!(linked.len(), 1);
        assert!(linked[0].info.allow_implicit_invocation);
    }

    #[cfg(unix)]
    fn create_dir_symlink(target: &Path, link: &Path) -> bool {
        std::os::unix::fs::symlink(target, link).is_ok()
    }

    #[cfg(windows)]
    fn create_dir_symlink(target: &Path, link: &Path) -> bool {
        std::os::windows::fs::symlink_dir(target, link).is_ok()
    }
}

#[cfg(test)]
mod remote_scan_tests {
    use super::SkillRegistry;
    use crate::agentic::workspace::{WorkspaceDirEntry, WorkspaceFileSystem};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{Duration, Instant};

    #[derive(Default)]
    struct DelayedFs {
        active: AtomicUsize,
        peak: AtomicUsize,
        calls: AtomicUsize,
        installation_lock: Option<String>,
        pi_settings: Option<String>,
    }

    impl DelayedFs {
        async fn round_trip(&self) {
            let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
            self.peak.fetch_max(active, Ordering::SeqCst);
            self.calls.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(10)).await;
            self.active.fetch_sub(1, Ordering::SeqCst);
        }
    }

    #[async_trait::async_trait]
    impl WorkspaceFileSystem for DelayedFs {
        async fn read_file(&self, path: &str) -> anyhow::Result<Vec<u8>> {
            Ok(self.read_file_text(path).await?.into_bytes())
        }
        async fn read_file_text(&self, path: &str) -> anyhow::Result<String> {
            self.round_trip().await;
            if path.ends_with("/.pi/settings.json") {
                assert_eq!(path, "/remote/project/.pi/settings.json");
                return self
                    .pi_settings
                    .clone()
                    .ok_or_else(|| anyhow::anyhow!("missing settings"));
            }
            if path.ends_with("skills-lock.json") {
                assert_eq!(path, "/remote/project/skills-lock.json");
                return self
                    .installation_lock
                    .clone()
                    .ok_or_else(|| anyhow::anyhow!("missing lock"));
            }
            if path.ends_with("openai.yaml") {
                return Ok("policy:\n  allow_implicit_invocation: false\n".into());
            }
            let name = path.rsplit('/').nth(1).unwrap();
            Ok(format!(
                "---\nname: {name}\ndescription: {path}\n---\nBody\n"
            ))
        }
        async fn write_file(&self, _: &str, _: &[u8]) -> anyhow::Result<()> {
            anyhow::bail!("read-only fixture")
        }
        async fn exists(&self, path: &str) -> anyhow::Result<bool> {
            if path.ends_with("/.pi/settings.json") {
                return Ok(self.pi_settings.is_some());
            }
            if path.ends_with("skills-lock.json") {
                return Ok(self.installation_lock.is_some());
            }
            self.is_file(path).await
        }
        async fn is_file(&self, path: &str) -> anyhow::Result<bool> {
            self.round_trip().await;
            Ok(path.ends_with("SKILL.md") || path.ends_with("skill-00/agents/openai.yaml"))
        }
        async fn is_dir(&self, path: &str) -> anyhow::Result<bool> {
            self.round_trip().await;
            Ok(path.contains("/.openbitfun/")
                || path.contains("/.codex/")
                || (self.installation_lock.is_some() && path.contains("/.agents/")))
        }
        async fn read_dir(&self, path: &str) -> anyhow::Result<Vec<WorkspaceDirEntry>> {
            self.round_trip().await;
            Ok((0..13)
                .rev()
                .map(|index| WorkspaceDirEntry {
                    name: format!("skill-{index:02}"),
                    path: format!("{path}/skill-{index:02}"),
                    is_dir: true,
                    is_symlink: index == 12,
                    modified: None,
                })
                .collect())
        }
    }

    #[tokio::test]
    async fn remote_pi_settings_paths_report_unsupported_without_local_substitution() {
        let fs = DelayedFs {
            pi_settings: Some(r#"{"skills":["/controller/private-skills"]}"#.into()),
            ..Default::default()
        };
        let scan = SkillRegistry::scan_remote_project_skills(&fs, "/remote/project").await;
        assert!(scan.diagnostics.iter().any(|entry| entry.source_id == "pi"
            && entry.path == "/remote/project/.pi/settings.json"
            && entry.message.contains("not supported")));
        assert!(!scan
            .candidates
            .iter()
            .any(|candidate| candidate.info.path.contains("controller")));
    }

    #[tokio::test]
    async fn remote_scan_reads_provenance_from_the_remote_project_only() {
        let mut fs = DelayedFs {
            installation_lock: Some(
                r#"{"version":1,"skills":{
                "skill-00":{"source":"remote/skills","sourceType":"github"},
                "deleted":{"source":"missing/skills","sourceType":"github"}
            }}"#
                .into(),
            ),
            ..Default::default()
        };
        let skills = SkillRegistry::scan_remote_project_skills(&fs, "/remote/project/")
            .await
            .into_candidates();
        assert_eq!(skills.len(), 39);
        let installed = skills
            .iter()
            .filter(|skill| skill.info.installation_source.is_some())
            .collect::<Vec<_>>();
        assert_eq!(installed.len(), 1);
        assert_eq!(installed[0].info.source_slot, "agents");
        assert_eq!(installed[0].info.name, "skill-00");
        assert_eq!(
            installed[0].info.installation_source.as_deref(),
            Some("remote/skills")
        );

        fs.installation_lock = Some("invalid remote lock".into());
        let skills = SkillRegistry::scan_remote_project_skills(&fs, "/remote/project/")
            .await
            .into_candidates();
        assert_eq!(skills.len(), 39);
        assert!(skills
            .iter()
            .all(|skill| skill.info.installation_source.is_none()));
    }

    #[tokio::test]
    async fn remote_scan_preserves_order_and_policy_with_bounded_io() {
        let fs = DelayedFs::default();
        let start = Instant::now();
        let skills = SkillRegistry::scan_remote_project_skills(&fs, "/remote/project/")
            .await
            .into_candidates();
        eprintln!(
            "remote scan: {:?}, {} logical IO calls, peak {}",
            start.elapsed(),
            fs.calls.load(Ordering::SeqCst),
            fs.peak.load(Ordering::SeqCst)
        );
        assert_eq!(skills.len(), 26);
        for group in skills.chunks(13) {
            assert_eq!(
                group
                    .iter()
                    .map(|skill| skill.info.name.clone())
                    .collect::<Vec<_>>(),
                (0..13)
                    .map(|index| format!("skill-{index:02}"))
                    .collect::<Vec<_>>()
            );
            assert!(!group[0].info.allow_implicit_invocation);
            assert!(group[1].info.allow_implicit_invocation);
        }
        assert!(skills[0].priority < skills[13].priority);
        // 92 discovery/policy calls plus one provenance existence check for each native package.
        assert!(fs.calls.load(Ordering::SeqCst) <= 92 + 13);
        assert_eq!(fs.active.load(Ordering::SeqCst), 0);
        assert!(fs.peak.load(Ordering::SeqCst) > 1);
        assert!(fs.peak.load(Ordering::SeqCst) <= super::REMOTE_SKILL_SCAN_CONCURRENCY);

        // The same project catalog on disk must retain the remote scan's source
        // precedence and invocation policy, without involving user-global skills.
        let local_root = tempfile::tempdir().unwrap();
        for parent in [".openbitfun", ".codex"] {
            for index in 0..13 {
                let name = format!("skill-{index:02}");
                let dir = local_root.path().join(parent).join("skills").join(&name);
                std::fs::create_dir_all(&dir).unwrap();
                std::fs::write(
                    dir.join("SKILL.md"),
                    format!("---\nname: {name}\ndescription: fixture\n---\nBody\n"),
                )
                .unwrap();
                if index == 0 {
                    std::fs::create_dir_all(dir.join("agents")).unwrap();
                    std::fs::write(
                        dir.join("agents/openai.yaml"),
                        "policy:\n  allow_implicit_invocation: false\n",
                    )
                    .unwrap();
                }
            }
        }
        let start = Instant::now();
        let mut local = Vec::new();
        for entry in SkillRegistry::get_project_skill_roots(local_root.path()) {
            local.extend(SkillRegistry::scan_skills_in_dir(&entry).await.candidates);
        }
        eprintln!(
            "local project scan: {:?}, {} skills",
            start.elapsed(),
            local.len()
        );
        let catalog = |candidates: Vec<openbitfun_agent_runtime::skills::SkillCandidate>| {
            candidates
                .into_iter()
                .map(|candidate| {
                    (
                        candidate.info.key,
                        candidate.info.name,
                        candidate.info.allow_implicit_invocation,
                        candidate.priority,
                    )
                })
                .collect::<Vec<_>>()
        };
        // Local directory enumeration is sorted by the shared resolver later.
        local.sort_by(|a, b| {
            a.priority
                .cmp(&b.priority)
                .then(a.info.name.cmp(&b.info.name))
        });
        assert_eq!(catalog(local), catalog(skills));
    }
}
