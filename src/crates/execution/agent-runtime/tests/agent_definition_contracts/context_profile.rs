use openbitfun_agent_runtime::context_profile::{
    ContextProfile, ContextProfilePolicy, ModelCapabilityProfile, StructuralExclusionKind,
};

#[test]
fn context_profile_maps_long_running_agents_to_long_task_profile() {
    for agent_type in [
        "Standard",
        "DeepReview",
        "DeepResearch",
        "ComputerUse",
        "ReviewFrontend",
        "ReviewSecurity",
    ] {
        assert_eq!(
            ContextProfile::for_agent_type(agent_type),
            ContextProfile::LongTask,
            "{agent_type} should use the long-task profile"
        );
    }
}

#[test]
fn context_profile_maps_conversation_agents_to_conversation_profile() {
    for agent_type in ["Cowork", "Claw", "unknown-custom-agent"] {
        assert_eq!(
            ContextProfile::for_agent_type(agent_type),
            ContextProfile::Conversation,
            "{agent_type} should use the conversation profile"
        );
    }
}

#[test]
fn context_profile_review_custom_subagents_can_be_promoted_to_long_task_profile() {
    assert_eq!(
        ContextProfile::for_agent_context("legal-domain-reviewer", true),
        ContextProfile::LongTask
    );
    assert_eq!(
        ContextProfile::for_agent_context("legal-domain-reviewer", false),
        ContextProfile::Conversation
    );
}

#[test]
fn context_profile_long_task_policy_preserves_current_context_defaults() {
    let policy = ContextProfilePolicy::for_agent_context(
        "DeepReview",
        false,
        ModelCapabilityProfile::Standard,
    );

    assert_eq!(policy.profile, ContextProfile::LongTask);
    assert_eq!(policy.compression_contract_limit, 8);
    assert_eq!(policy.subagent_concurrency_cap, 5);
    assert_eq!(policy.repeated_tool_signature_threshold, 3);
    assert_eq!(policy.consecutive_failed_command_threshold, 2);
}

#[test]
fn context_profile_conversation_policy_keeps_more_recent_chat_context() {
    let policy =
        ContextProfilePolicy::for_agent_context("Cowork", false, ModelCapabilityProfile::Standard);

    assert_eq!(policy.profile, ContextProfile::Conversation);
    assert_eq!(policy.compression_contract_limit, 4);
    assert_eq!(policy.subagent_concurrency_cap, 2);
    assert_eq!(policy.repeated_tool_signature_threshold, 4);
    assert_eq!(policy.consecutive_failed_command_threshold, 3);
}

#[test]
fn context_profile_weak_model_override_shortens_contract_and_caps_fanout() {
    let standard = ContextProfilePolicy::for_agent_context(
        "DeepReview",
        false,
        ModelCapabilityProfile::Standard,
    );
    let weak =
        ContextProfilePolicy::for_agent_context("DeepReview", false, ModelCapabilityProfile::Weak);

    assert_eq!(weak.profile, ContextProfile::LongTask);
    assert!(weak.compression_contract_limit < standard.compression_contract_limit);
    assert!(weak.subagent_concurrency_cap < standard.subagent_concurrency_cap);
    assert!(weak.repeated_tool_signature_threshold < standard.repeated_tool_signature_threshold);
    assert_eq!(weak.compression_contract_limit, 4);
    assert_eq!(weak.subagent_concurrency_cap, 2);
    assert_eq!(weak.repeated_tool_signature_threshold, 2);
}

#[test]
fn context_profile_model_capability_profile_only_marks_explicit_weak_models() {
    assert_eq!(
        ModelCapabilityProfile::from_model_id(Some("claude-3-haiku")),
        ModelCapabilityProfile::Weak
    );
    assert_eq!(
        ModelCapabilityProfile::from_model_id(Some("gpt-5.4-mini")),
        ModelCapabilityProfile::Weak
    );
    assert_eq!(
        ModelCapabilityProfile::from_model_id(Some("fast")),
        ModelCapabilityProfile::Standard,
        "configured model slots should not be treated as weak before resolving"
    );
    assert_eq!(
        ModelCapabilityProfile::from_model_id(None),
        ModelCapabilityProfile::Standard
    );
}

#[test]
fn context_profile_configured_subagent_concurrency_is_capped_by_policy() {
    let long_task = ContextProfilePolicy::for_agent_context(
        "DeepReview",
        false,
        ModelCapabilityProfile::Standard,
    );
    let conversation =
        ContextProfilePolicy::for_agent_context("Cowork", false, ModelCapabilityProfile::Standard);

    assert_eq!(long_task.effective_subagent_max_concurrency(64), 5);
    assert_eq!(long_task.effective_subagent_max_concurrency(3), 3);
    assert_eq!(conversation.effective_subagent_max_concurrency(64), 2);
    assert_eq!(conversation.effective_subagent_max_concurrency(1), 1);
}

#[test]
fn context_profile_subagent_policy_combines_parent_workload_and_child_model() {
    let policy = ContextProfilePolicy::for_subagent_context_and_models(
        "custom-security-reviewer",
        true,
        Some("claude-3-haiku"),
        Some("DeepReview"),
        false,
        Some("gpt-5"),
    );

    assert_eq!(policy.profile, ContextProfile::LongTask);
    assert_eq!(policy.compression_contract_limit, 4);
    assert_eq!(policy.subagent_concurrency_cap, 2);
    assert_eq!(policy.repeated_tool_signature_threshold, 2);
}

#[test]
fn context_profile_subagent_policy_inherits_parent_long_task_when_child_is_plain() {
    let policy = ContextProfilePolicy::for_subagent_context_and_models(
        "Explore",
        false,
        None,
        Some("DeepReview"),
        false,
        Some("gpt-5"),
    );

    assert_eq!(policy.profile, ContextProfile::LongTask);
    assert_eq!(policy.subagent_concurrency_cap, 5);
}

#[test]
fn context_profile_loop_detection_tier_table_is_profile_and_model_aware() {
    let long_task_standard = ContextProfilePolicy::for_agent_context(
        "DeepReview",
        false,
        ModelCapabilityProfile::Standard,
    );
    let long_task_weak =
        ContextProfilePolicy::for_agent_context("DeepReview", false, ModelCapabilityProfile::Weak);
    let conversation_standard =
        ContextProfilePolicy::for_agent_context("Cowork", false, ModelCapabilityProfile::Standard);
    let conversation_weak =
        ContextProfilePolicy::for_agent_context("Cowork", false, ModelCapabilityProfile::Weak);

    assert_eq!(long_task_standard.loop_detection.threshold_scale, 1.0);
    assert_eq!(long_task_weak.loop_detection.threshold_scale, 1.25);
    assert_eq!(conversation_standard.loop_detection.threshold_scale, 1.25);
    assert_eq!(conversation_weak.loop_detection.threshold_scale, 1.5);

    // Weak models are strictly more conservative: they need more evidence
    // before any signal fires, in either profile.
    assert!(
        long_task_weak.loop_detection.threshold_scale
            > long_task_standard.loop_detection.threshold_scale
    );
    assert!(
        conversation_weak.loop_detection.threshold_scale
            > conversation_standard.loop_detection.threshold_scale
    );
    // A conversation tolerates more legitimate repetition than a long task.
    assert!(
        conversation_standard.loop_detection.threshold_scale
            >= long_task_standard.loop_detection.threshold_scale
    );
    // The calibration baseline is never made more aggressive than 1.0.
    for policy in [
        long_task_standard,
        long_task_weak,
        conversation_standard,
        conversation_weak,
    ] {
        assert!(policy.loop_detection.threshold_scale >= 1.0);
    }

    // A subagent whose resolved model is weak inherits the long-task weak tier.
    let subagent = ContextProfilePolicy::for_subagent_context_and_models(
        "custom-security-reviewer",
        true,
        Some("claude-3-haiku"),
        Some("DeepReview"),
        false,
        Some("gpt-5"),
    );
    assert_eq!(subagent.loop_detection.threshold_scale, 1.25);
}

#[test]
fn context_profile_loop_detection_keeps_structural_exclusions_across_tiers() {
    let long_task = ContextProfilePolicy::for_agent_context(
        "DeepReview",
        false,
        ModelCapabilityProfile::Standard,
    );
    let weak =
        ContextProfilePolicy::for_agent_context("Cowork", false, ModelCapabilityProfile::Weak);

    // Exclusions are correctness, not tuning: no tier drops one.
    assert_eq!(
        long_task.loop_detection.structural_exclusions,
        StructuralExclusionKind::ALL
    );
    assert_eq!(
        weak.loop_detection.structural_exclusions,
        long_task.loop_detection.structural_exclusions
    );
    for kind in StructuralExclusionKind::ALL {
        assert!(long_task.loop_detection.excludes(*kind), "{kind:?}");
        assert!(weak.loop_detection.excludes(*kind), "{kind:?}");
    }
}

#[test]
fn context_profile_loop_detection_threshold_resolution_prefers_explicit_override() {
    let policy =
        ContextProfilePolicy::for_agent_context("Cowork", false, ModelCapabilityProfile::Standard);

    let scaled = policy.resolve_loop_detection_threshold(None, 0.7);
    assert!((scaled - 0.7 * 1.25).abs() < f32::EPSILON);
    assert_eq!(
        policy.resolve_loop_detection_threshold(Some(0.95), 0.7),
        0.95
    );
    assert_eq!(
        policy.resolve_loop_detection_threshold(Some(0.0), 0.7),
        scaled,
        "a non-positive override counts as unset"
    );

    let long_task = ContextProfilePolicy::for_agent_context(
        "DeepReview",
        false,
        ModelCapabilityProfile::Standard,
    );
    assert_eq!(
        long_task.resolve_loop_detection_threshold(None, 0.85),
        0.85,
        "the long-task standard tier uses the calibrated baseline as configured"
    );
}
