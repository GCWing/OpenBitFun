use super::catalog::builtin_skill_group_key;
use super::keys::normalize_skill_keys as normalize_skill_key_list;
use super::resolver::{
    resolve_skill_default_enabled_for_mode, resolve_skill_state_for_mode, UserModeSkillOverrides,
};
use super::types::{ModeSkillInfo, SkillData, SkillInfo, SkillLocation};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone)]
pub struct SkillCandidate {
    pub info: SkillInfo,
    pub priority: usize,
}

impl SkillCandidate {
    pub fn from_data(
        mut data: SkillData,
        slot: &str,
        source_id: &str,
        source_label: &str,
        key_prefix: &str,
        priority: usize,
        is_builtin: bool,
    ) -> Self {
        data.source_slot = slot.to_string();
        data.key = build_skill_key(key_prefix, slot, &data.dir_name);
        let group_key = if is_builtin {
            builtin_skill_group_key(&data.dir_name).map(str::to_string)
        } else {
            None
        };

        Self {
            info: SkillInfo {
                key: data.key,
                name: data.name,
                description: data.description,
                path: data.path,
                level: data.location,
                source_slot: data.source_slot,
                source_id: source_id.to_string(),
                source_label: source_label.to_string(),
                installation_source: None,
                import_origin: None,
                entry_file: data.entry_file,
                dir_name: data.dir_name,
                is_builtin,
                group_key,
                is_shadowed: false,
                shadowed_by_key: None,
                allow_implicit_invocation: data.allow_implicit_invocation,
                allow_user_invocation: data.allow_user_invocation,
                argument_hint: data.argument_hint,
            },
            priority,
        }
    }
}

#[derive(Debug, Clone)]
pub enum ExplicitSkillInvocationResolution {
    Found(SkillInfo),
    NotFound,
    DisabledForMode { mode_id: String },
}

fn build_skill_key(prefix: &str, slot: &str, dir_name: &str) -> String {
    format!("{}::{}::{}", prefix, slot, dir_name)
}

pub fn normalize_skill_keys(keys: Vec<String>) -> Vec<String> {
    normalize_skill_key_list(keys)
}

pub fn sort_skills(mut skills: Vec<SkillInfo>) -> Vec<SkillInfo> {
    skills.sort_by(|a, b| {
        skill_level_rank(a.level)
            .cmp(&skill_level_rank(b.level))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
            .then_with(|| a.key.cmp(&b.key))
    });
    skills
}

pub fn sort_skill_candidates_by_dir(mut skills: Vec<SkillCandidate>) -> Vec<SkillCandidate> {
    skills.sort_by(|a, b| {
        a.info
            .dir_name
            .to_lowercase()
            .cmp(&b.info.dir_name.to_lowercase())
            .then_with(|| a.info.dir_name.cmp(&b.info.dir_name))
            .then_with(|| a.info.key.cmp(&b.info.key))
    });
    skills
}

fn skill_level_rank(level: SkillLocation) -> u8 {
    match level {
        SkillLocation::Project => 0,
        SkillLocation::User => 1,
    }
}

fn skill_candidate_precedence(candidate: &SkillCandidate) -> (usize, u8, String, String, String) {
    (
        candidate.priority,
        skill_level_rank(candidate.info.level),
        candidate.info.name.to_lowercase(),
        candidate.info.name.clone(),
        candidate.info.key.clone(),
    )
}

fn sort_resolved_skill_candidates(mut resolved: Vec<SkillCandidate>) -> Vec<SkillCandidate> {
    resolved.sort_by_cached_key(skill_candidate_precedence);
    resolved
}

fn sort_skill_candidates_for_resolution(
    mut candidates: Vec<SkillCandidate>,
) -> Vec<SkillCandidate> {
    candidates.sort_by(|a, b| {
        skill_candidate_precedence(a)
            .cmp(&skill_candidate_precedence(b))
            .then_with(|| a.info.path.cmp(&b.info.path))
    });
    candidates
}

pub fn resolve_visible_skills(candidates: Vec<SkillCandidate>) -> Vec<SkillInfo> {
    let mut by_name: HashMap<String, SkillCandidate> = HashMap::new();
    for candidate in sort_skill_candidates_for_resolution(candidates) {
        match by_name.get(&candidate.info.name) {
            Some(existing)
                if skill_candidate_precedence(existing)
                    <= skill_candidate_precedence(&candidate) => {}
            _ => {
                by_name.insert(candidate.info.name.clone(), candidate);
            }
        }
    }

    sort_resolved_skill_candidates(by_name.into_values().collect())
        .into_iter()
        .map(|candidate| candidate.info)
        .collect()
}

pub fn filter_implicitly_invocable_skills(skills: Vec<SkillInfo>) -> Vec<SkillInfo> {
    skills
        .into_iter()
        .filter(|skill| skill.allow_implicit_invocation)
        .collect()
}

pub fn filter_user_invocable_skills(skills: Vec<SkillInfo>) -> Vec<SkillInfo> {
    skills
        .into_iter()
        .filter(|skill| skill.allow_user_invocation)
        .collect()
}

pub fn is_skill_globally_enabled(
    skill: &SkillInfo,
    globally_disabled_user_skills: &HashSet<String>,
) -> bool {
    !globally_disabled_user_skills.contains(&skill.key)
}

pub fn filter_candidates_for_mode(
    candidates: Vec<SkillCandidate>,
    mode_id: &str,
    user_overrides: &UserModeSkillOverrides,
    disabled_project_skills: &HashSet<String>,
) -> Vec<SkillCandidate> {
    candidates
        .into_iter()
        .filter(|candidate| {
            resolve_skill_state_for_mode(
                &candidate.info,
                mode_id,
                user_overrides,
                disabled_project_skills,
            )
            .effective_enabled
        })
        .collect()
}

/// Annotate each candidate with shadowing information.
///
/// For every skill with a higher-priority skill of the same name, set the
/// shadowed fields to point at the winner.
pub fn annotate_shadowed_skills(candidates: Vec<SkillCandidate>) -> Vec<SkillInfo> {
    let mut by_name: HashMap<String, SkillCandidate> = HashMap::new();
    for candidate in &candidates {
        match by_name.get(&candidate.info.name) {
            Some(existing)
                if skill_candidate_precedence(existing)
                    <= skill_candidate_precedence(candidate) => {}
            _ => {
                by_name.insert(candidate.info.name.clone(), candidate.clone());
            }
        }
    }

    candidates
        .into_iter()
        .map(|mut candidate| {
            if let Some(winner) = by_name.get(&candidate.info.name) {
                if winner.info.key != candidate.info.key {
                    candidate.info.is_shadowed = true;
                    candidate.info.shadowed_by_key = Some(winner.info.key.clone());
                }
            }
            candidate.info
        })
        .collect()
}

pub fn build_mode_skill_infos(
    all_skills: Vec<SkillInfo>,
    resolved_skills: Vec<SkillInfo>,
    mode_id: &str,
    user_overrides: &UserModeSkillOverrides,
    disabled_project_skills: &HashSet<String>,
    globally_disabled_user_skills: &HashSet<String>,
) -> Vec<ModeSkillInfo> {
    let resolved_by_name: HashMap<String, String> = resolved_skills
        .iter()
        .map(|skill| (skill.name.clone(), skill.key.clone()))
        .collect();
    let resolved_keys: HashSet<String> =
        resolved_skills.into_iter().map(|skill| skill.key).collect();

    all_skills
        .into_iter()
        .map(|mut skill| {
            let state = resolve_skill_state_for_mode(
                &skill,
                mode_id,
                user_overrides,
                disabled_project_skills,
            );
            let globally_enabled = is_skill_globally_enabled(&skill, globally_disabled_user_skills);
            let selected_for_runtime = globally_enabled && resolved_keys.contains(&skill.key);
            let mode_winner_key = state
                .effective_enabled
                .then(|| resolved_by_name.get(&skill.name))
                .flatten()
                .filter(|winner_key| **winner_key != skill.key)
                .cloned();

            skill.is_shadowed = mode_winner_key.is_some();
            skill.shadowed_by_key = mode_winner_key;

            ModeSkillInfo {
                skill,
                default_enabled: state.default_enabled,
                globally_enabled,
                effective_enabled: state.effective_enabled,
                disabled_by_mode: !state.effective_enabled,
                selected_for_runtime,
                state_reason: state.reason,
            }
        })
        .collect()
}

pub fn resolve_default_hidden_builtin_for_explicit_invocation(
    skill_name: &str,
    candidates: Vec<SkillCandidate>,
    agent_type: Option<&str>,
) -> ExplicitSkillInvocationResolution {
    let Some(mode_id) = agent_type.map(str::trim).filter(|value| !value.is_empty()) else {
        return ExplicitSkillInvocationResolution::NotFound;
    };

    let Some(info) = resolve_visible_skills(candidates)
        .into_iter()
        .find(|skill| skill.name == skill_name)
    else {
        return ExplicitSkillInvocationResolution::NotFound;
    };

    // A mode may keep computer-use builtins default-hidden while still
    // allowing an exact explicit invocation.
    if info.level == SkillLocation::User
        && info.is_builtin
        && matches!(info.group_key.as_deref(), Some("computer-use"))
        && !resolve_skill_default_enabled_for_mode(&info, mode_id)
    {
        return ExplicitSkillInvocationResolution::Found(info);
    }

    ExplicitSkillInvocationResolution::DisabledForMode {
        mode_id: mode_id.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolved_candidate_sort_is_case_insensitive_ascending_and_stable_for_equal_precedence() {
        let beta_first = candidate("beta", "project::beta", "/tmp/first");
        let alpha = candidate("ALPHA", "project::alpha", "/tmp/alpha");
        let beta_second = candidate("beta", "project::beta", "/tmp/second");
        let zulu = candidate("Zulu", "project::zulu", "/tmp/zulu");

        let sorted = sort_resolved_skill_candidates(vec![beta_first, zulu, alpha, beta_second]);

        assert_eq!(
            sorted
                .iter()
                .map(|candidate| candidate.info.path.as_str())
                .collect::<Vec<_>>(),
            ["/tmp/alpha", "/tmp/first", "/tmp/second", "/tmp/zulu"]
        );
    }

    fn candidate(name: &str, key: &str, path: &str) -> SkillCandidate {
        SkillCandidate {
            info: SkillInfo {
                key: key.to_string(),
                name: name.to_string(),
                description: String::new(),
                path: path.to_string(),
                level: SkillLocation::Project,
                source_slot: String::new(),
                source_id: String::new(),
                source_label: String::new(),
                installation_source: None,
                import_origin: None,
                entry_file: None,
                dir_name: name.to_string(),
                is_builtin: false,
                group_key: None,
                is_shadowed: false,
                shadowed_by_key: None,
                allow_implicit_invocation: true,
                allow_user_invocation: true,
                argument_hint: None,
            },
            priority: 0,
        }
    }
}
