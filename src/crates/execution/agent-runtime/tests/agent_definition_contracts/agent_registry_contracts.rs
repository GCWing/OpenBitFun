use openbitfun_agent_runtime::agents::{
    builtin_agent_definition_specs, default_model_id_for_builtin_agent,
    is_swarm_delegate_agent_type, is_swarm_planner_agent_type, mode_config_profile_label,
    mode_config_profile_member_mode_ids, mode_presentation_rank, resolve_mode_config_profile_id,
    resolve_subagent_availability, resolve_subagent_default_enabled,
    standard_harness_user_context_policy, subagent_source_kind, subagent_source_presentation_rank,
    BuiltinAgentCategory, BuiltinSubagentExposure, SubAgentSource, SubagentOverrideLayers,
    SubagentOverrideState, SubagentSourceKind, SubagentStateReason, SubagentVisibilityPolicy,
    STANDARD_HARNESS_CONFIG_ID, STANDARD_HARNESS_CONFIG_LABEL, STANDARD_HARNESS_CONFIG_MEMBERS,
};
use openbitfun_agent_runtime::deep_review::canonical_review_worker_agent_type;

#[test]
fn visibility_policy_supports_public_restricted_hidden_and_denied_parents() {
    let public = SubagentVisibilityPolicy::public();
    assert!(public.can_access_from_parent(None));
    assert!(public.can_access_from_parent(Some("Standard")));

    let restricted = SubagentVisibilityPolicy::restricted(["DeepResearch"]);
    assert!(!restricted.can_access_from_parent(None));
    assert!(restricted.can_access_from_parent(Some("DeepResearch")));
    assert!(!restricted.can_access_from_parent(Some("Standard")));

    let denied = SubagentVisibilityPolicy::public().deny_for(["BlockedParent"]);
    assert!(!denied.can_access_from_parent(Some("BlockedParent")));
    assert!(denied.can_access_from_parent(Some("Standard")));

    let hidden = SubagentVisibilityPolicy::hidden(["DeepReview"]);
    assert_eq!(hidden.summary().exposure, BuiltinSubagentExposure::Hidden);
    assert!(!hidden.summary().show_in_global_registry);
    assert!(hidden.can_access_from_parent(Some("DeepReview")));
}

#[test]
fn swarm_agent_type_contract_is_closed() {
    for parent in ["Ultimate", "SwarmPlanner"] {
        assert!(is_swarm_planner_agent_type(parent));
    }
    assert!(!is_swarm_planner_agent_type("GeneralPurpose"));

    for delegate in ["SwarmPlanner", "SwarmWorker", "SwarmReviewer"] {
        assert!(is_swarm_delegate_agent_type(delegate));
    }
    assert!(!is_swarm_delegate_agent_type("Explore"));
    assert!(!is_swarm_delegate_agent_type("GeneralPurpose"));
}

#[test]
fn availability_preserves_builtin_project_and_user_override_layering() {
    let builtin = resolve_subagent_availability(
        SubagentSourceKind::Builtin,
        false,
        SubagentOverrideLayers {
            project_override: Some(SubagentOverrideState::Enabled),
            user_override: Some(SubagentOverrideState::Enabled),
        },
    );
    assert!(!builtin.default_enabled);
    assert_eq!(builtin.override_state, Some(SubagentOverrideState::Enabled));
    assert_eq!(
        builtin.state_reason,
        Some(SubagentStateReason::EnabledByUserOverride)
    );

    let project = resolve_subagent_availability(
        SubagentSourceKind::Project,
        true,
        SubagentOverrideLayers {
            project_override: Some(SubagentOverrideState::Disabled),
            user_override: Some(SubagentOverrideState::Enabled),
        },
    );
    assert_eq!(
        project.override_state,
        Some(SubagentOverrideState::Disabled)
    );
    assert_eq!(
        project.state_reason,
        Some(SubagentStateReason::DisabledByProjectOverride)
    );

    let custom_default = resolve_subagent_availability(
        SubagentSourceKind::User,
        true,
        SubagentOverrideLayers::default(),
    );
    assert!(custom_default.effective_enabled);
    assert_eq!(
        custom_default.state_reason,
        Some(SubagentStateReason::CustomDefaultEnabled)
    );
}

#[test]
fn default_enabled_uses_visibility_only_for_builtin_subagents() {
    let hidden = SubagentVisibilityPolicy::hidden(["DeepReview"]);

    assert!(!resolve_subagent_default_enabled(
        SubagentSourceKind::Builtin,
        &hidden,
        Some("Standard")
    ));
    assert!(resolve_subagent_default_enabled(
        SubagentSourceKind::Builtin,
        &hidden,
        Some("DeepReview")
    ));
    assert!(resolve_subagent_default_enabled(
        SubagentSourceKind::Project,
        &hidden,
        Some("Standard")
    ));
    assert!(resolve_subagent_default_enabled(
        SubagentSourceKind::User,
        &hidden,
        Some("Standard")
    ));
}

#[test]
fn shared_coding_modes_resolve_to_the_same_config_profile() {
    for mode_id in STANDARD_HARNESS_CONFIG_MEMBERS {
        assert_eq!(
            resolve_mode_config_profile_id(mode_id).as_ref(),
            STANDARD_HARNESS_CONFIG_ID
        );
    }

    assert_eq!(resolve_mode_config_profile_id("Cowork").as_ref(), "Cowork");
    assert_eq!(
        mode_config_profile_member_mode_ids(STANDARD_HARNESS_CONFIG_ID),
        STANDARD_HARNESS_CONFIG_MEMBERS
    );
    assert_eq!(
        mode_config_profile_label(STANDARD_HARNESS_CONFIG_ID),
        Some(STANDARD_HARNESS_CONFIG_LABEL)
    );
}

#[test]
fn subagent_source_contract_preserves_runtime_kind_and_presentation_order() {
    assert_eq!(
        subagent_source_kind(Some(SubAgentSource::Builtin)),
        SubagentSourceKind::Builtin
    );
    assert_eq!(
        subagent_source_kind(Some(SubAgentSource::Project)),
        SubagentSourceKind::Project
    );
    assert_eq!(
        subagent_source_kind(Some(SubAgentSource::User)),
        SubagentSourceKind::User
    );
    assert_eq!(
        subagent_source_kind(Some(SubAgentSource::External)),
        SubagentSourceKind::External
    );
    assert_eq!(subagent_source_kind(None), SubagentSourceKind::Unspecified);

    assert_eq!(
        subagent_source_presentation_rank(Some(SubAgentSource::Builtin)),
        0
    );
    assert_eq!(
        subagent_source_presentation_rank(Some(SubAgentSource::Project)),
        1
    );
    assert_eq!(
        subagent_source_presentation_rank(Some(SubAgentSource::User)),
        2
    );
    assert_eq!(
        subagent_source_presentation_rank(Some(SubAgentSource::External)),
        3
    );
    assert_eq!(subagent_source_presentation_rank(None), 4);
}

#[test]
fn mode_presentation_and_shared_context_policy_match_existing_mode_contract() {
    assert_eq!(mode_presentation_rank("Standard"), 0);
    assert_eq!(mode_presentation_rank("Cowork"), 1);
    assert_eq!(mode_presentation_rank("Ultimate"), 3);
    assert_eq!(mode_presentation_rank("Creative"), 4);
    assert_eq!(mode_presentation_rank("unknown"), 99);

    assert_eq!(
        standard_harness_user_context_policy().cache_scope_key(),
        "workspace_context|workspace_instructions|project_layout|memory_summary"
    );
}

#[test]
fn builtin_agent_definition_catalog_preserves_order_categories_models_and_visibility() {
    let specs = builtin_agent_definition_specs();
    let ids: Vec<_> = specs.iter().map(|spec| spec.id).collect();
    assert_eq!(
        ids,
        vec![
            "Minimal",
            "Standard",
            "Cowork",
            "Creative",
            "Claw",
            "DeepResearch",
            "Ultimate",
            "SwarmPlanner",
            "SwarmWorker",
            "SwarmReviewer",
            "ComputerUse",
            "Explore",
            "GeneralPurpose",
            "ResearchSpecialist",
            "ReviewWorker",
            "ReviewJudge",
            "ReviewFixer",
            "CodeReview",
            "DeepReview",
            "GenerateDoc",
            "OpenBitFun",
            "MemoryPhase2",
        ]
    );

    assert_eq!(specs[0].category, BuiltinAgentCategory::Mode);
    let control_agent = specs
        .iter()
        .find(|spec| spec.id == "OpenBitFun")
        .expect("OpenBitFun control agent should be registered");
    assert_eq!(control_agent.category, BuiltinAgentCategory::Hidden);
    assert_eq!(control_agent.default_model_id, "primary");
    assert_eq!(default_model_id_for_builtin_agent("OpenBitFun"), "primary");
    let swarm_planner = specs
        .iter()
        .find(|spec| spec.id == "SwarmPlanner")
        .expect("SwarmPlanner spec should exist");
    assert_eq!(swarm_planner.category, BuiltinAgentCategory::SubAgent);
    let code_review = specs
        .iter()
        .find(|spec| spec.id == "CodeReview")
        .expect("CodeReview spec should exist");
    assert_eq!(code_review.category, BuiltinAgentCategory::SubAgent);
    assert!(code_review
        .visibility_policy
        .can_access_from_parent(Some("Standard")));
    assert!(!code_review.visibility_policy.show_in_global_registry);
    assert_eq!(default_model_id_for_builtin_agent("Standard"), "primary");
    assert_eq!(default_model_id_for_builtin_agent("Explore"), "primary");
    assert_eq!(
        default_model_id_for_builtin_agent("GeneralPurpose"),
        "primary"
    );
    assert_eq!(default_model_id_for_builtin_agent("GenerateDoc"), "fast");
    assert_eq!(
        default_model_id_for_builtin_agent("MemoryPhase2"),
        "primary"
    );
    assert_eq!(
        default_model_id_for_builtin_agent("ResearchSpecialist"),
        "fast"
    );
    assert_eq!(
        default_model_id_for_builtin_agent("ReviewArchitecture"),
        "fast"
    );
    assert_eq!(default_model_id_for_builtin_agent("ReviewGeneral"), "fast");
    assert_eq!(default_model_id_for_builtin_agent("ReviewWorker"), "fast");
    assert_eq!(default_model_id_for_builtin_agent("Ultimate"), "primary");
    assert_eq!(
        default_model_id_for_builtin_agent("SwarmPlanner"),
        "primary"
    );
    assert_eq!(default_model_id_for_builtin_agent("SwarmWorker"), "primary");
    assert_eq!(default_model_id_for_builtin_agent("SwarmReviewer"), "fast");

    for swarm_id in ["SwarmPlanner", "SwarmWorker", "SwarmReviewer"] {
        let swarm = specs
            .iter()
            .find(|spec| spec.id == swarm_id)
            .expect("Swarm agent should be registered");
        assert!(swarm
            .visibility_policy
            .can_access_from_parent(Some("Ultimate")));
        assert!(swarm
            .visibility_policy
            .can_access_from_parent(Some("SwarmPlanner")));
        assert!(!swarm.visibility_policy.show_in_global_registry);
        assert!(!swarm
            .visibility_policy
            .can_access_from_parent(Some("Standard")));
    }

    let computer_use = specs
        .iter()
        .find(|spec| spec.id == "ComputerUse")
        .expect("ComputerUse spec should exist");
    assert_eq!(
        computer_use.visibility_policy.summary().exposure,
        BuiltinSubagentExposure::Restricted
    );
    assert!(computer_use
        .visibility_policy
        .can_access_from_parent(Some("Claw")));
    assert!(!computer_use
        .visibility_policy
        .can_access_from_parent(Some("Standard")));

    let research_specialist = specs
        .iter()
        .find(|spec| spec.id == "ResearchSpecialist")
        .expect("ResearchSpecialist spec should exist");
    assert_eq!(research_specialist.default_model_id, "fast");
}

#[test]
fn legacy_fixed_reviewers_canonicalize_to_the_dynamic_worker() {
    for legacy_id in [
        "ReviewBusinessLogic",
        "ReviewPerformance",
        "ReviewSecurity",
        "ReviewArchitecture",
        "ReviewFrontend",
        "ReviewGeneral",
    ] {
        assert_eq!(
            canonical_review_worker_agent_type(legacy_id),
            "ReviewWorker"
        );
    }
    assert_eq!(
        canonical_review_worker_agent_type("ReviewJudge"),
        "ReviewJudge"
    );
}

#[test]
fn shared_coding_modes_have_identical_builtin_subagent_defaults() {
    let specs = builtin_agent_definition_specs();

    for spec in specs
        .iter()
        .filter(|spec| spec.category == BuiltinAgentCategory::SubAgent)
    {
        let expected = resolve_subagent_default_enabled(
            SubagentSourceKind::Builtin,
            &spec.visibility_policy,
            Some("Standard"),
        );

        for mode_id in STANDARD_HARNESS_CONFIG_MEMBERS {
            assert_eq!(
                resolve_subagent_default_enabled(
                    SubagentSourceKind::Builtin,
                    &spec.visibility_policy,
                    Some(mode_id),
                ),
                expected,
                "builtin subagent {} differs for shared coding mode {}",
                spec.id,
                mode_id
            );
        }
    }
}
