use crate::service::config::global::GlobalConfigManager;
use crate::service::config::types::{AgentProfileConfig, GlobalConfig};
use crate::util::errors::OpenBitFunResult;
use openbitfun_agent_runtime::permission::{
    AUTO_APPROVE_ASK_CONTEXT_KEY, PERMISSION_MODE_CONTEXT_KEY,
};
use openbitfun_runtime_ports::{
    resolve_child_permission_policy, resolve_permission_policy, ChildPermissionPolicyLayers,
    PermissionConstraintLayer, PermissionEffect, PermissionMode, PermissionPolicyLayers,
    PermissionRule, PermissionRuntimeCeiling, ResolvedPermissionPolicy,
};

/// Reads the effective mode a submission carried into tool execution.
///
/// The owning surface resolves the layered selection once and writes it to the
/// execution context, so this is a lookup and not a second resolution. The
/// legacy auto-approve flag is still honored for submissions and product
/// surfaces that predate the mode key.
pub(crate) fn permission_mode_from_context(
    global: &GlobalConfig,
    context_vars: &std::collections::HashMap<String, String>,
) -> PermissionMode {
    if let Some(mode) = context_vars
        .get(PERMISSION_MODE_CONTEXT_KEY)
        .map(String::as_str)
        .and_then(PermissionMode::parse)
    {
        return mode;
    }

    let default_mode = PermissionMode::from_config(&global.tool_permissions);
    match context_vars
        .get(AUTO_APPROVE_ASK_CONTEXT_KEY)
        .and_then(|value| value.parse::<bool>().ok())
    {
        // A legacy flag only speaks for the auto-approval half. It must not
        // downgrade a full-access selection that the same turn resolved.
        Some(true) if default_mode != PermissionMode::FullAccess => PermissionMode::AutoApprove,
        Some(false) if default_mode == PermissionMode::AutoApprove => PermissionMode::Ask,
        _ => default_mode,
    }
}

pub(crate) fn derive_parent_permission_runtime_ceiling(
    agent_profile: Option<&AgentProfileConfig>,
    agent_definition_constraints: Option<&PermissionConstraintLayer>,
) -> PermissionRuntimeCeiling {
    let mut rules: Vec<PermissionRule> = agent_profile
        .into_iter()
        .flat_map(|profile| profile.tool_permission_rules.iter())
        .filter(|rule| {
            rule.effect == PermissionEffect::Deny
                || (rule.action == "external_directory" && rule.effect == PermissionEffect::Ask)
        })
        .cloned()
        .collect();
    rules.extend(
        agent_definition_constraints
            .into_iter()
            .flat_map(PermissionConstraintLayer::rules)
            .filter(|rule| rule.effect != PermissionEffect::Allow)
            .cloned(),
    );

    PermissionRuntimeCeiling::try_new(rules)
        .expect("parent permission ceiling extraction must exclude allow rules")
}

pub(crate) async fn load_parent_permission_runtime_ceiling(
    agent_type: Option<&str>,
    workspace_id: Option<&str>,
) -> OpenBitFunResult<PermissionRuntimeCeiling> {
    let service = GlobalConfigManager::get_service().await?;
    let global: GlobalConfig = service.get_config(None).await?;
    let profile = agent_type.and_then(|agent_type| {
        let profile_id = crate::agentic::agents::resolve_mode_config_profile_id(agent_type);
        global.ai.agent_profiles.get(profile_id.as_ref())
    });
    let definition_constraints = agent_type.and_then(|agent_type| {
        crate::agentic::agents::get_agent_registry()
            .get_agent(agent_type, workspace_id)
            .map(|agent| agent.permission_constraints().clone())
    });
    Ok(derive_parent_permission_runtime_ceiling(
        profile,
        definition_constraints.as_ref(),
    ))
}

/// Resolves one turn's effective policy.
///
/// `mode` is the already-resolved turn/session/global selection. It only
/// replaces the preset baseline; every later layer (global rules, project,
/// agent, enforced, and the constraint layers appended below) is evaluated
/// afterwards and can still tighten the result.
pub(crate) fn resolve_effective_permission_policy(
    global: &GlobalConfig,
    mode: Option<PermissionMode>,
    project_rules: &[PermissionRule],
    agent_profile: Option<&AgentProfileConfig>,
    agent_definition_constraints: Option<&PermissionConstraintLayer>,
    parent_runtime_ceiling: Option<&PermissionRuntimeCeiling>,
    enforced: &[PermissionRule],
) -> ResolvedPermissionPolicy {
    let agent_rules = agent_profile
        .map(|profile| profile.tool_permission_rules.as_slice())
        .unwrap_or(&[]);

    let resolved = match parent_runtime_ceiling {
        Some(parent_runtime_ceiling) => {
            resolve_child_permission_policy(ChildPermissionPolicyLayers {
                product_defaults: &[],
                global: &global.tool_permissions.policy,
                mode,
                project: project_rules,
                child_agent: agent_rules,
                parent_runtime_ceiling,
                enforced,
            })
        }
        None => resolve_permission_policy(PermissionPolicyLayers {
            product_defaults: &[],
            global: &global.tool_permissions.policy,
            mode,
            project: project_rules,
            agent: agent_rules,
            enforced,
        }),
    };
    let Some(agent_definition_constraints) =
        agent_definition_constraints.filter(|constraints| !constraints.is_empty())
    else {
        return resolved;
    };
    let (rules, mut constraint_layers) = resolved.into_parts();
    constraint_layers.insert(0, agent_definition_constraints.clone());
    ResolvedPermissionPolicy::new(rules, constraint_layers)
}

#[cfg(test)]
mod tests {
    use super::*;
    use openbitfun_runtime_ports::{PermissionEvaluator, PermissionPolicyPreset};

    fn rule(action: &str, resource: &str, effect: PermissionEffect) -> PermissionRule {
        PermissionRule::new(action, resource, effect)
    }

    #[test]
    fn context_mode_key_outranks_the_legacy_auto_approve_flag() {
        let mut global = GlobalConfig::default();
        global.tool_permissions.policy.preset =
            openbitfun_runtime_ports::PermissionPolicyPreset::Ask;
        global.tool_permissions.interaction.auto_approve_ask = true;
        let mut context_vars = std::collections::HashMap::new();

        assert_eq!(
            permission_mode_from_context(&global, &context_vars),
            PermissionMode::AutoApprove
        );

        context_vars.insert(
            PERMISSION_MODE_CONTEXT_KEY.to_string(),
            "full_access".to_string(),
        );
        context_vars.insert(
            AUTO_APPROVE_ASK_CONTEXT_KEY.to_string(),
            "false".to_string(),
        );
        assert_eq!(
            permission_mode_from_context(&global, &context_vars),
            PermissionMode::FullAccess
        );
    }

    #[test]
    fn legacy_auto_approve_flag_never_downgrades_a_full_access_default() {
        let mut global = GlobalConfig::default();
        global.tool_permissions.policy.preset = PermissionPolicyPreset::FullAccess;
        let mut context_vars = std::collections::HashMap::new();
        context_vars.insert(AUTO_APPROVE_ASK_CONTEXT_KEY.to_string(), "true".to_string());

        assert_eq!(
            permission_mode_from_context(&global, &context_vars),
            PermissionMode::FullAccess
        );
    }

    #[test]
    fn session_full_access_mode_is_still_bounded_by_project_rules() {
        let global = GlobalConfig::default();
        let project = vec![rule("edit", "generated/*", PermissionEffect::Deny)];

        let resolved = resolve_effective_permission_policy(
            &global,
            Some(PermissionMode::FullAccess),
            &project,
            None,
            None,
            None,
            &[],
        );
        let evaluator = PermissionEvaluator::case_sensitive();

        assert_eq!(
            evaluator.evaluate_policy_resource("edit", "src/main.rs", &resolved),
            PermissionEffect::Allow
        );
        assert_eq!(
            evaluator.evaluate_policy_resource("edit", "generated/api.rs", &resolved),
            PermissionEffect::Deny
        );
    }

    #[test]
    fn parent_ceiling_combines_profile_and_agent_constraints_without_allows() {
        let profile = AgentProfileConfig {
            tool_permission_rules: vec![
                rule("read", "*", PermissionEffect::Allow),
                rule("bash", "rm *", PermissionEffect::Deny),
                rule("edit", "src/*", PermissionEffect::Ask),
                rule("external_directory", "*", PermissionEffect::Ask),
                rule("external_directory", "C:/blocked", PermissionEffect::Deny),
                rule("external_directory", "C:/trusted", PermissionEffect::Allow),
            ],
            ..AgentProfileConfig::default()
        };

        let definition_constraints = PermissionConstraintLayer::new(vec![
            rule("bash", "git push *", PermissionEffect::Ask),
            rule("bash", "git status", PermissionEffect::Allow),
            rule("edit", "secrets/*", PermissionEffect::Deny),
        ]);
        let ceiling =
            derive_parent_permission_runtime_ceiling(Some(&profile), Some(&definition_constraints));

        assert_eq!(
            ceiling.rules(),
            [
                rule("bash", "rm *", PermissionEffect::Deny),
                rule("external_directory", "*", PermissionEffect::Ask),
                rule("external_directory", "C:/blocked", PermissionEffect::Deny),
                rule("bash", "git push *", PermissionEffect::Ask),
                rule("edit", "secrets/*", PermissionEffect::Deny),
            ]
        );
        assert!(ceiling
            .rules()
            .iter()
            .all(|rule| rule.effect != PermissionEffect::Allow));
    }

    #[test]
    fn top_level_resolution_keeps_existing_global_project_and_agent_order() {
        let mut global = GlobalConfig::default();
        global.tool_permissions.policy.preset = PermissionPolicyPreset::FullAccess;
        global.tool_permissions.policy.rules = vec![rule("bash", "rm *", PermissionEffect::Ask)];
        let project = vec![rule("edit", "generated/*", PermissionEffect::Deny)];
        let profile = AgentProfileConfig {
            tool_permission_rules: vec![rule(
                "edit",
                "generated/review.md",
                PermissionEffect::Allow,
            )],
            ..AgentProfileConfig::default()
        };

        let resolved = resolve_effective_permission_policy(
            &global,
            None,
            &project,
            Some(&profile),
            None,
            None,
            &[],
        );

        assert_eq!(
            PermissionEvaluator::case_sensitive().evaluate_policy_resource(
                "edit",
                "generated/review.md",
                &resolved,
            ),
            PermissionEffect::Allow
        );
        assert_eq!(
            PermissionEvaluator::case_sensitive().evaluate_policy_resource(
                "edit",
                "generated/api.rs",
                &resolved,
            ),
            PermissionEffect::Deny
        );
    }

    #[test]
    fn child_profile_allow_cannot_loosen_parent_deny_or_external_directory_ask() {
        let mut global = GlobalConfig::default();
        global.tool_permissions.policy.preset = PermissionPolicyPreset::FullAccess;
        let child_profile = AgentProfileConfig {
            tool_permission_rules: vec![
                rule("bash", "rm *", PermissionEffect::Allow),
                rule("external_directory", "*", PermissionEffect::Allow),
            ],
            ..AgentProfileConfig::default()
        };
        let ceiling = PermissionRuntimeCeiling::try_new(vec![
            rule("bash", "rm *", PermissionEffect::Deny),
            rule("external_directory", "*", PermissionEffect::Ask),
        ])
        .expect("test ceiling should be valid");

        let resolved = resolve_effective_permission_policy(
            &global,
            None,
            &[],
            Some(&child_profile),
            None,
            Some(&ceiling),
            &[],
        );
        let evaluator = PermissionEvaluator::case_sensitive();

        assert_eq!(
            evaluator.evaluate_policy_resource("bash", "rm -rf target", &resolved),
            PermissionEffect::Deny
        );
        assert_eq!(
            evaluator.evaluate_policy_resource("external_directory", "C:/outside", &resolved),
            PermissionEffect::Ask
        );
    }
}
