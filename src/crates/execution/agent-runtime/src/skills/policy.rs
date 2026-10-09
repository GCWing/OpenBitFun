use super::catalog::{builtin_skill_spec, BuiltinSkillGroup, BuiltinSkillSpec};
use crate::agents::{resolve_mode_config_profile_id, STANDARD_HARNESS_CONFIG_ID};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SkillModeId {
    CodingShared,
    Cowork,
    Claw,
    Creative,
    ComputerUse,
    DeepResearch,
    Ultra,
    SwarmWorker,
    Other,
}

impl SkillModeId {
    fn parse(mode_id: &str) -> Self {
        match mode_id.trim() {
            STANDARD_HARNESS_CONFIG_ID => Self::CodingShared,
            "Cowork" => Self::Cowork,
            "Claw" => Self::Claw,
            "Creative" => Self::Creative,
            "ComputerUse" => Self::ComputerUse,
            "DeepResearch" => Self::DeepResearch,
            "Ultimate" => Self::Ultra,
            "SwarmWorker" => Self::SwarmWorker,
            _ => Self::Other,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PolicyEffect {
    Enable,
    Disable,
}

impl PolicyEffect {
    fn is_enabled(self) -> bool {
        matches!(self, Self::Enable)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SkillSelector {
    Group(BuiltinSkillGroup),
    DirName(&'static str),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SkillPolicyRule {
    selector: SkillSelector,
    effect: PolicyEffect,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ModeSkillPolicy {
    builtin_default: PolicyEffect,
    rules: &'static [SkillPolicyRule],
}

const DISABLE_OFFICE: SkillPolicyRule = SkillPolicyRule {
    selector: SkillSelector::Group(BuiltinSkillGroup::Office),
    effect: PolicyEffect::Disable,
};

const DISABLE_MINIAPP: SkillPolicyRule = SkillPolicyRule {
    selector: SkillSelector::Group(BuiltinSkillGroup::MiniApp),
    effect: PolicyEffect::Disable,
};

const DISABLE_CREATION: SkillPolicyRule = SkillPolicyRule {
    selector: SkillSelector::Group(BuiltinSkillGroup::Creation),
    effect: PolicyEffect::Disable,
};

// Canvas is an optional artifact workflow. Keep its built-in skills available
// for explicit user selection without making every conversation eligible for
// implicit Canvas generation.
const DISABLE_CANVAS: SkillPolicyRule = SkillPolicyRule {
    selector: SkillSelector::Group(BuiltinSkillGroup::Canvas),
    effect: PolicyEffect::Disable,
};

const DISABLE_DEBUGGING: SkillPolicyRule = SkillPolicyRule {
    selector: SkillSelector::Group(BuiltinSkillGroup::Debugging),
    effect: PolicyEffect::Disable,
};

// ControlHub's browser domain is the default browser-automation path for modes
// that carry it. Ultra and SwarmWorker do not, so their narrow policies below
// expose agent-browser instead.
const DISABLE_COMPUTER_USE: SkillPolicyRule = SkillPolicyRule {
    selector: SkillSelector::Group(BuiltinSkillGroup::ComputerUse),
    effect: PolicyEffect::Disable,
};

const ENABLE_OFFICE: SkillPolicyRule = SkillPolicyRule {
    selector: SkillSelector::Group(BuiltinSkillGroup::Office),
    effect: PolicyEffect::Enable,
};

const ENABLE_META: SkillPolicyRule = SkillPolicyRule {
    selector: SkillSelector::Group(BuiltinSkillGroup::Meta),
    effect: PolicyEffect::Enable,
};

const ENABLE_COORDINATION: SkillPolicyRule = SkillPolicyRule {
    selector: SkillSelector::Group(BuiltinSkillGroup::Coordination),
    effect: PolicyEffect::Enable,
};

const ENABLE_PLANNING: SkillPolicyRule = SkillPolicyRule {
    selector: SkillSelector::Group(BuiltinSkillGroup::Planning),
    effect: PolicyEffect::Enable,
};

const ENABLE_AGENT_BROWSER: SkillPolicyRule = SkillPolicyRule {
    selector: SkillSelector::DirName("agent-browser"),
    effect: PolicyEffect::Enable,
};

const ENABLE_PLAN: SkillPolicyRule = SkillPolicyRule {
    selector: SkillSelector::DirName("plan"),
    effect: PolicyEffect::Enable,
};

const OPEN_META_ONLY_POLICY: ModeSkillPolicy = ModeSkillPolicy {
    builtin_default: PolicyEffect::Disable,
    rules: &[ENABLE_META],
};

const AGENTIC_POLICY: ModeSkillPolicy = ModeSkillPolicy {
    builtin_default: PolicyEffect::Enable,
    rules: &[
        DISABLE_OFFICE,
        DISABLE_COMPUTER_USE,
        DISABLE_MINIAPP,
        DISABLE_CREATION,
        DISABLE_CANVAS,
    ],
};

const CLAW_POLICY: ModeSkillPolicy = ModeSkillPolicy {
    builtin_default: PolicyEffect::Enable,
    rules: &[
        DISABLE_OFFICE,
        DISABLE_COMPUTER_USE,
        DISABLE_MINIAPP,
        DISABLE_CREATION,
        DISABLE_DEBUGGING,
        DISABLE_CANVAS,
    ],
};

const CREATIVE_POLICY: ModeSkillPolicy = ModeSkillPolicy {
    builtin_default: PolicyEffect::Enable,
    rules: &[
        DISABLE_OFFICE,
        DISABLE_COMPUTER_USE,
        DISABLE_DEBUGGING,
        DISABLE_CANVAS,
    ],
};

const COWORK_POLICY: ModeSkillPolicy = ModeSkillPolicy {
    builtin_default: PolicyEffect::Disable,
    rules: &[
        ENABLE_OFFICE,
        ENABLE_META,
        ENABLE_COORDINATION,
        ENABLE_PLANNING,
    ],
};

const DEEP_RESEARCH_POLICY: ModeSkillPolicy = ModeSkillPolicy {
    builtin_default: PolicyEffect::Disable,
    rules: &[ENABLE_META, ENABLE_COORDINATION],
};

const ULTRA_POLICY: ModeSkillPolicy = ModeSkillPolicy {
    builtin_default: PolicyEffect::Disable,
    rules: &[ENABLE_PLAN, ENABLE_AGENT_BROWSER],
};

const SWARM_WORKER_POLICY: ModeSkillPolicy = ModeSkillPolicy {
    builtin_default: PolicyEffect::Disable,
    rules: &[ENABLE_AGENT_BROWSER],
};

fn policy_for_mode(mode_id: &str) -> ModeSkillPolicy {
    let policy_scope = resolve_mode_config_profile_id(mode_id);
    match SkillModeId::parse(policy_scope.as_ref()) {
        SkillModeId::CodingShared => AGENTIC_POLICY,
        SkillModeId::Claw => CLAW_POLICY,
        SkillModeId::Creative => CREATIVE_POLICY,
        SkillModeId::Cowork => COWORK_POLICY,
        SkillModeId::DeepResearch => DEEP_RESEARCH_POLICY,
        SkillModeId::Ultra => ULTRA_POLICY,
        SkillModeId::SwarmWorker => SWARM_WORKER_POLICY,
        SkillModeId::ComputerUse | SkillModeId::Other => OPEN_META_ONLY_POLICY,
    }
}

fn selector_matches(selector: SkillSelector, spec: &BuiltinSkillSpec) -> bool {
    match selector {
        SkillSelector::Group(group) => spec.group == group,
        SkillSelector::DirName(dir_name) => spec.dir_name == dir_name,
    }
}

fn resolve_builtin_default_effect(spec: &BuiltinSkillSpec, mode_id: &str) -> PolicyEffect {
    let policy = policy_for_mode(mode_id);
    let mut current = policy.builtin_default;

    for rule in policy.rules {
        if selector_matches(rule.selector, spec) {
            current = rule.effect;
        }
    }

    current
}

pub fn resolve_builtin_default_enabled(dir_name: &str, mode_id: &str) -> Option<bool> {
    builtin_skill_spec(dir_name)
        .map(|spec| resolve_builtin_default_effect(spec, mode_id).is_enabled())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::{STANDARD_HARNESS_CONFIG_ID, STANDARD_HARNESS_CONFIG_MEMBERS};
    use crate::skills::catalog::BUILTIN_SKILL_SPECS;

    #[test]
    fn agent_browser_defaults_on_only_for_ultra_and_swarm_worker() {
        for mode_id in [
            "Standard",
            "Standard",
            "Claw",
            "Creative",
            "Cowork",
            "ComputerUse",
            "DeepResearch",
            "Team",
            "SwarmPlanner",
            "SwarmReviewer",
            "SomeUnknownMode",
        ] {
            assert_eq!(
                resolve_builtin_default_enabled("agent-browser", mode_id),
                Some(false),
                "agent-browser should default off for mode {mode_id}"
            );
        }

        for mode_id in ["Ultimate", "SwarmWorker"] {
            assert_eq!(
                resolve_builtin_default_enabled("agent-browser", mode_id),
                Some(true),
                "agent-browser should be available in {mode_id}"
            );
        }
    }

    #[test]
    fn swarm_agents_expose_only_their_requested_builtin_skills_by_default() {
        for spec in BUILTIN_SKILL_SPECS {
            assert_eq!(
                resolve_builtin_default_enabled(spec.dir_name, "Ultimate"),
                Some(matches!(spec.dir_name, "plan" | "agent-browser")),
                "Ultra has unexpected default exposure for {}",
                spec.dir_name
            );
            assert_eq!(
                resolve_builtin_default_enabled(spec.dir_name, "SwarmWorker"),
                Some(spec.dir_name == "agent-browser"),
                "SwarmWorker has unexpected default exposure for {}",
                spec.dir_name
            );
        }
    }

    #[test]
    fn canvas_skills_default_off_in_every_mode() {
        for skill in [
            "agent-eval-canvas",
            "docs-canvas",
            "openbitfun-canvas",
            "pr-review-canvas",
        ] {
            for mode_id in [
                "Standard",
                "Standard",
                "Claw",
                "Creative",
                "Cowork",
                "ComputerUse",
                "DeepResearch",
                "Ultimate",
                "SwarmWorker",
                "SomeUnknownMode",
            ] {
                assert_eq!(
                    resolve_builtin_default_enabled(skill, mode_id),
                    Some(false),
                    "Canvas skill {skill} must stay opt-in for mode {mode_id}"
                );
            }
        }
    }

    #[test]
    fn shared_coding_modes_use_their_profile_builtin_skill_defaults() {
        for spec in BUILTIN_SKILL_SPECS {
            let expected =
                resolve_builtin_default_enabled(spec.dir_name, STANDARD_HARNESS_CONFIG_ID);
            for mode_id in STANDARD_HARNESS_CONFIG_MEMBERS {
                assert_eq!(
                    resolve_builtin_default_enabled(spec.dir_name, mode_id),
                    expected,
                    "builtin skill {} differs for shared coding mode {}",
                    spec.dir_name,
                    mode_id
                );
            }
        }
    }

    #[test]
    fn debug_skill_defaults_on_only_in_agentic() {
        for mode_id in ["Standard", "Standard"] {
            assert_eq!(
                resolve_builtin_default_enabled("debug", mode_id),
                Some(true),
                "debug should default on for agentic profile identity {mode_id}"
            );
        }

        for mode_id in [
            "Claw",
            "Creative",
            "Cowork",
            "ComputerUse",
            "DeepResearch",
            "Ultimate",
            "SwarmWorker",
            "Team",
            "SomeUnknownMode",
        ] {
            assert_eq!(
                resolve_builtin_default_enabled("debug", mode_id),
                Some(false),
                "debug should default off outside agentic: {mode_id}"
            );
        }
    }

    #[test]
    fn multitask_skill_replaces_multitask_mode_in_coding_workflows() {
        for mode_id in [
            "Standard",
            "Standard",
            "Claw",
            "Cowork",
            "Creative",
            "DeepResearch",
        ] {
            assert_eq!(
                resolve_builtin_default_enabled("multitask", mode_id),
                Some(true),
                "multitask should be available in {mode_id}"
            );
        }

        for mode_id in ["ComputerUse", "Ultimate", "SwarmWorker", "SomeUnknownMode"] {
            assert_eq!(
                resolve_builtin_default_enabled("multitask", mode_id),
                Some(false),
                "multitask should remain opt-in in {mode_id}"
            );
        }
    }

    #[test]
    fn plan_skill_defaults_on_for_planning_capable_workflows() {
        for mode_id in [
            "Standard", "Standard", "Claw", "Cowork", "Creative", "Ultimate",
        ] {
            assert_eq!(
                resolve_builtin_default_enabled("plan", mode_id),
                Some(true),
                "plan should be available in {mode_id}"
            );
        }

        for mode_id in [
            "ComputerUse",
            "DeepResearch",
            "SwarmWorker",
            "SwarmPlanner",
            "SwarmReviewer",
            "SomeUnknownMode",
        ] {
            assert_eq!(
                resolve_builtin_default_enabled("plan", mode_id),
                Some(false),
                "plan should remain opt-in or unavailable in {mode_id}"
            );
        }
    }

    #[test]
    fn product_creation_skills_default_only_in_creative_mode() {
        for skill in ["miniapp-dev", "openbitfun-frontend-dev"] {
            for mode_id in [
                "Standard",
                "Standard",
                "Claw",
                "Creative",
                "Cowork",
                "ComputerUse",
                "DeepResearch",
                "Ultimate",
                "SwarmWorker",
                "SomeUnknownMode",
            ] {
                assert_eq!(
                    resolve_builtin_default_enabled(skill, mode_id),
                    Some(mode_id == "Creative"),
                    "creation skill {skill} has unexpected default exposure in {mode_id}"
                );
            }
        }
    }
}
