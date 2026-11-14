use openbitfun_product_domains::tool_permissions::{
    merge_permission_rule_layers, resolve_child_permission_policy, resolve_permission_policy,
    wildcard_matches, ChildPermissionPolicyLayers, PermissionApprovalModelKind,
    PermissionApprovalOnAsk, PermissionApprovalOnError, PermissionApprovalStrategy,
    PermissionConstraintLayer, PermissionDelegationContext, PermissionEffect, PermissionEvaluator,
    PermissionPolicyConfig, PermissionPolicyLayers, PermissionPolicyPreset, PermissionReply,
    PermissionReplySource, PermissionRequest, PermissionRequestEvent, PermissionRequestSource,
    PermissionRequestSourceKind, PermissionResourceCaseSensitivity, PermissionRule,
    PermissionRuntimeCeiling, ResolvedPermissionPolicy, ToolPermissionConfig,
};
use openbitfun_product_domains::tool_permissions::{
    resolve_permission_mode, PermissionMode, PermissionModeLayers, PermissionModeSource,
};
use serde_json::json;
use serde_json::Map;

fn rule(action: &str, resource: &str, effect: PermissionEffect) -> PermissionRule {
    PermissionRule::new(action, resource, effect)
}

#[test]
fn constraint_layers_can_only_tighten_the_resolved_host_policy() {
    let evaluator = PermissionEvaluator::case_sensitive();
    let policy = ResolvedPermissionPolicy::new(
        vec![
            rule("read", "secrets/*", PermissionEffect::Deny),
            rule("read", "*", PermissionEffect::Allow),
        ],
        vec![PermissionConstraintLayer::new(vec![
            rule("read", "*", PermissionEffect::Deny),
            rule("read", "public/*", PermissionEffect::Allow),
            rule("edit", "*", PermissionEffect::Ask),
        ])],
    );

    assert_eq!(
        evaluator.evaluate_policy_resource("read", "public/README.md", &policy),
        PermissionEffect::Allow,
        "an allow may relax an earlier rule inside one constraint layer"
    );
    assert_eq!(
        evaluator.evaluate_policy_resource("read", "secrets/token.txt", &policy),
        PermissionEffect::Deny,
        "a constraint allow must never override a host deny"
    );
    assert_eq!(
        evaluator.evaluate_policy_resource("edit", "src/main.rs", &policy),
        PermissionEffect::Ask,
        "a constraint ask must tighten a host allow"
    );
}

fn policy(preset: PermissionPolicyPreset, rules: Vec<PermissionRule>) -> PermissionPolicyConfig {
    PermissionPolicyConfig { preset, rules }
}

#[test]
fn tool_permission_config_defaults_to_full_access_with_auto_approve_disabled() {
    let config = ToolPermissionConfig::default();

    assert_eq!(config.policy.preset, PermissionPolicyPreset::FullAccess);
    assert!(config.policy.rules.is_empty());
    assert!(!config.interaction.auto_approve_ask);
    assert_eq!(
        serde_json::to_value(config).expect("serialize tool permission config"),
        json!({
            "policy": {
                "preset": "full_access",
                "rules": [],
            },
            "interaction": {
                "auto_approve_ask": false,
            },
        })
    );
}

#[test]
fn policy_presets_expand_into_ordinary_baseline_rules() {
    let ask = policy(PermissionPolicyPreset::Ask, Vec::new());
    let full_access = policy(PermissionPolicyPreset::FullAccess, Vec::new());
    let evaluator = PermissionEvaluator::case_sensitive();

    let ask_rules = resolve_permission_policy(PermissionPolicyLayers {
        product_defaults: &[],
        global: &ask,
        mode: None,
        project: &[],
        agent: &[],
        enforced: &[],
    });
    let full_access_rules = resolve_permission_policy(PermissionPolicyLayers {
        product_defaults: &[],
        global: &full_access,
        mode: None,
        project: &[],
        agent: &[],
        enforced: &[],
    });

    assert_eq!(
        ask_rules.rules(),
        vec![
            rule("*", "*", PermissionEffect::Ask),
            rule("read", "*", PermissionEffect::Allow),
            rule("read", "*/.env", PermissionEffect::Ask),
            rule("read", "*/.env.*", PermissionEffect::Ask),
            rule("read", "*/.env.example", PermissionEffect::Allow),
            rule("websearch", "*", PermissionEffect::Allow),
            rule("webfetch", "*", PermissionEffect::Allow),
            rule("task", "*", PermissionEffect::Allow),
            rule("skill", "*", PermissionEffect::Allow),
            rule("git", "git status *", PermissionEffect::Allow),
            rule("git", "git diff *", PermissionEffect::Allow),
            rule("git", "git log *", PermissionEffect::Allow),
            rule("git", "git show *", PermissionEffect::Allow),
            rule("git", "git blame *", PermissionEffect::Allow),
            rule("git", "git rev-parse *", PermissionEffect::Allow),
            rule("git", "git describe *", PermissionEffect::Allow),
            rule("git", "git shortlog *", PermissionEffect::Allow),
            rule("git", "git branch", PermissionEffect::Allow),
        ]
    );
    assert_eq!(
        full_access_rules.rules(),
        vec![rule("*", "*", PermissionEffect::Allow)]
    );
    assert_eq!(
        evaluator.evaluate_policy_resource("edit", "src/main.rs", &ask_rules),
        PermissionEffect::Ask
    );
    assert_eq!(
        evaluator.evaluate_policy_resource("edit", "src/main.rs", &full_access_rules),
        PermissionEffect::Allow
    );
}

#[test]
fn ask_preset_allows_low_risk_actions_and_keeps_mutations_guarded() {
    let rules = resolve_permission_policy(PermissionPolicyLayers {
        product_defaults: &[],
        global: &policy(PermissionPolicyPreset::Ask, Vec::new()),
        mode: None,
        project: &[],
        agent: &[],
        enforced: &[],
    });
    let evaluator = PermissionEvaluator::case_sensitive();

    for (action, resource) in [
        ("read", "C:/repo/README.md"),
        ("read", "C:/repo/.env.example"),
        ("websearch", "OpenBitFun permission model"),
        ("webfetch", "https://example.com/docs"),
        ("task", "general"),
        ("task", "send_input:session-1"),
        ("skill", "pdf"),
        ("git", "git status"),
        ("git", "git diff --staged"),
        ("git", "git log --oneline -10"),
        ("git", "git show HEAD"),
        ("git", "git blame src/main.rs"),
        ("git", "git rev-parse HEAD"),
        ("git", "git describe --tags"),
        ("git", "git shortlog -sn"),
        ("git", "git branch"),
    ] {
        assert_eq!(
            evaluator.evaluate_policy_resource(action, resource, &rules),
            PermissionEffect::Allow,
            "{action} {resource}"
        );
    }

    for (action, resource) in [
        ("read", "C:/repo/.env"),
        ("read", "C:/repo/.env.local"),
        ("external_directory", "C:/outside"),
        ("edit", "C:/repo/src/main.rs"),
        ("bash", "cargo test"),
        ("git", "git branch feature/new"),
        ("git", "git add src/main.rs"),
        ("git", "git commit -m change"),
        ("git", "git push origin main"),
        ("mcp", "server/tool"),
        ("future_action", "resource"),
    ] {
        assert_eq!(
            evaluator.evaluate_policy_resource(action, resource, &rules),
            PermissionEffect::Ask,
            "{action} {resource}"
        );
    }
}

#[test]
fn resolved_policy_preserves_layer_order_and_enforced_limits() {
    let product_defaults = vec![rule("read", "*", PermissionEffect::Allow)];
    let global = policy(
        PermissionPolicyPreset::FullAccess,
        vec![rule("bash", "rm *", PermissionEffect::Ask)],
    );
    let project = vec![rule("edit", "generated/*", PermissionEffect::Deny)];
    let agent = vec![rule("edit", "generated/review.md", PermissionEffect::Allow)];
    let enforced = vec![rule("edit", "generated/*", PermissionEffect::Deny)];

    let resolved = resolve_permission_policy(PermissionPolicyLayers {
        product_defaults: &product_defaults,
        global: &global,
        mode: None,
        project: &project,
        agent: &agent,
        enforced: &enforced,
    });

    assert_eq!(
        resolved.rules(),
        [
            product_defaults,
            PermissionPolicyPreset::FullAccess.baseline_rules(),
            global.rules,
            project,
            agent,
            enforced,
        ]
        .concat()
    );

    let evaluator = PermissionEvaluator::case_sensitive();
    assert_eq!(
        evaluator.evaluate_policy_resource("bash", "rm -rf target", &resolved),
        PermissionEffect::Ask
    );
    assert_eq!(
        evaluator.evaluate_policy_resource("edit", "generated/review.md", &resolved),
        PermissionEffect::Deny
    );
    assert_eq!(
        evaluator.evaluate_policy_resource("webfetch", "https://example.com", &resolved),
        PermissionEffect::Allow
    );
}

#[test]
fn runtime_ceiling_accepts_empty_ask_and_deny_rules() {
    assert!(PermissionRuntimeCeiling::try_new(Vec::new())
        .expect("empty ceiling should be valid")
        .is_empty());

    let rules = vec![
        rule("read", "secrets/*", PermissionEffect::Ask),
        rule("bash", "rm *", PermissionEffect::Deny),
    ];
    let ceiling = PermissionRuntimeCeiling::try_new(rules.clone())
        .expect("ask and deny rules should be valid ceiling restrictions");
    assert_eq!(ceiling.rules(), rules);
}

#[test]
fn runtime_ceiling_rejects_allow_rules_with_typed_context() {
    let error = PermissionRuntimeCeiling::try_new(vec![
        rule("read", "secrets/*", PermissionEffect::Ask),
        rule("bash", "cargo test", PermissionEffect::Allow),
    ])
    .expect_err("allow must not enter a runtime ceiling");

    assert_eq!(error.rule_index, 1);
    assert_eq!(error.action, "bash");
    assert_eq!(error.resource, "cargo test");
}

#[test]
fn child_policy_preserves_exact_layer_order_and_security_precedence() {
    let product_defaults = vec![rule("read", "*", PermissionEffect::Allow)];
    let global = policy(
        PermissionPolicyPreset::Ask,
        vec![rule("edit", "generated/*", PermissionEffect::Ask)],
    );
    let project = vec![rule("edit", "generated/*", PermissionEffect::Deny)];
    let child_agent = vec![rule("edit", "generated/review.md", PermissionEffect::Allow)];
    let ceiling_rules = vec![rule("edit", "generated/review.md", PermissionEffect::Ask)];
    let ceiling = PermissionRuntimeCeiling::try_new(ceiling_rules.clone())
        .expect("ask ceiling should be valid");
    let enforced = vec![rule("edit", "generated/review.md", PermissionEffect::Deny)];

    let resolved = resolve_child_permission_policy(ChildPermissionPolicyLayers {
        product_defaults: &product_defaults,
        global: &global,
        mode: None,
        project: &project,
        child_agent: &child_agent,
        parent_runtime_ceiling: &ceiling,
        enforced: &enforced,
    });

    assert_eq!(
        resolved.rules(),
        [
            product_defaults,
            PermissionPolicyPreset::Ask.baseline_rules(),
            global.rules,
            project,
            child_agent,
            enforced,
        ]
        .concat()
    );

    let evaluator = PermissionEvaluator::case_sensitive();
    assert_eq!(
        evaluator.evaluate_policy_resource("edit", "generated/review.md", &resolved),
        PermissionEffect::Deny,
        "enforced rules must remain later than the parent ceiling"
    );
}

#[test]
fn parent_ceiling_overrides_child_agent_allow() {
    let global = policy(PermissionPolicyPreset::FullAccess, Vec::new());
    let child_agent = vec![rule("read", "secrets/*", PermissionEffect::Allow)];
    let ceiling =
        PermissionRuntimeCeiling::try_new(vec![rule("read", "secrets/*", PermissionEffect::Deny)])
            .expect("deny ceiling should be valid");

    let resolved = resolve_child_permission_policy(ChildPermissionPolicyLayers {
        product_defaults: &[],
        global: &global,
        mode: None,
        project: &[],
        child_agent: &child_agent,
        parent_runtime_ceiling: &ceiling,
        enforced: &[],
    });

    assert_eq!(
        PermissionEvaluator::case_sensitive().evaluate_policy_resource(
            "read",
            "secrets/token.txt",
            &resolved,
        ),
        PermissionEffect::Deny
    );
}

#[test]
fn parent_ceiling_ask_does_not_loosen_child_agent_deny() {
    let global = policy(PermissionPolicyPreset::FullAccess, Vec::new());
    let child_agent = vec![rule("read", "secrets/*", PermissionEffect::Deny)];
    let ceiling =
        PermissionRuntimeCeiling::try_new(vec![rule("read", "secrets/*", PermissionEffect::Ask)])
            .expect("ask ceiling should be valid");

    let resolved = resolve_child_permission_policy(ChildPermissionPolicyLayers {
        product_defaults: &[],
        global: &global,
        mode: None,
        project: &[],
        child_agent: &child_agent,
        parent_runtime_ceiling: &ceiling,
        enforced: &[],
    });

    assert_eq!(
        PermissionEvaluator::case_sensitive().evaluate_policy_resource(
            "read",
            "secrets/token.txt",
            &resolved,
        ),
        PermissionEffect::Deny
    );
}

#[test]
fn task_and_skill_default_allow_do_not_authorize_child_tools() {
    let global = policy(PermissionPolicyPreset::Ask, Vec::new());
    let ceiling = PermissionRuntimeCeiling::default();
    let resolved = resolve_child_permission_policy(ChildPermissionPolicyLayers {
        product_defaults: &[],
        global: &global,
        mode: None,
        project: &[],
        child_agent: &[],
        parent_runtime_ceiling: &ceiling,
        enforced: &[],
    });
    let evaluator = PermissionEvaluator::case_sensitive();

    assert_eq!(
        evaluator.evaluate_policy_resource("task", "Explore", &resolved),
        PermissionEffect::Allow
    );
    assert_eq!(
        evaluator.evaluate_policy_resource("skill", "pdf", &resolved),
        PermissionEffect::Allow
    );
    assert_eq!(
        evaluator.evaluate_policy_resource("edit", "src/main.rs", &resolved),
        PermissionEffect::Ask
    );
}

#[test]
fn legacy_skip_confirmation_field_does_not_override_product_defaults() {
    let config: ToolPermissionConfig = serde_json::from_value(json!({
        "skip_tool_confirmation": true,
    }))
    .expect("deserialize legacy-shaped permission config");

    assert_eq!(config, ToolPermissionConfig::default());
}

#[test]
fn permission_rule_uses_stable_wire_values() {
    let value = serde_json::to_value(rule("read", "src/*", PermissionEffect::Ask))
        .expect("serialize permission rule");

    assert_eq!(
        value,
        json!({
            "action": "read",
            "resource": "src/*",
            "effect": "ask",
        })
    );
    assert_eq!(
        serde_json::from_value::<PermissionRule>(value).expect("deserialize permission rule"),
        rule("read", "src/*", PermissionEffect::Ask)
    );
}

#[test]
fn permission_reply_uses_stable_tagged_wire_values() {
    assert_eq!(
        serde_json::to_value(PermissionReply::Once).expect("serialize once reply"),
        json!({ "reply": "once" })
    );
    assert_eq!(
        serde_json::to_value(PermissionReply::Always).expect("serialize always reply"),
        json!({ "reply": "always" })
    );
    assert_eq!(
        serde_json::to_value(PermissionReply::Reject {
            feedback: Some("Use a read-only path".to_string()),
        })
        .expect("serialize reject reply"),
        json!({
            "reply": "reject",
            "feedback": "Use a read-only path",
        })
    );
}

#[test]
fn permission_request_correlation_fields_use_stable_wire_shape() {
    let request = PermissionRequest {
        request_id: "request-1".to_string(),
        round_id: "round-1".to_string(),
        order: 2,
        tool_call_id: Some("call-1".to_string()),
        project_path: Some("/workspace/project".to_string()),
        project_id: "project-1".to_string(),
        session_id: "session-1".to_string(),
        agent_id: "Standard".to_string(),
        action: "read".to_string(),
        resources: vec!["README.md".to_string()],
        save_resources: Vec::new(),
        source: PermissionRequestSource {
            kind: PermissionRequestSourceKind::ToolCall,
            identity: "Read".to_string(),
        },
        delegation: Some(PermissionDelegationContext {
            parent_session_id: "parent-session-1".to_string(),
            parent_dialog_turn_id: Some("parent-turn-1".to_string()),
            parent_tool_call_id: "parent-task-call-1".to_string(),
            subagent_type: "Explore".to_string(),
        }),
        display_metadata: Map::new(),
    };
    let value = serde_json::to_value(&request).expect("serialize permission request");
    assert_eq!(value["roundId"], "round-1");
    assert_eq!(value["order"], 2);
    assert_eq!(value["toolCallId"], "call-1");
    assert_eq!(value["projectPath"], "/workspace/project");
    assert_eq!(
        value["delegation"],
        json!({
            "parentSessionId": "parent-session-1",
            "parentDialogTurnId": "parent-turn-1",
            "parentToolCallId": "parent-task-call-1",
            "subagentType": "Explore",
        })
    );

    let top_level = PermissionRequest {
        delegation: None,
        ..request.clone()
    };
    let top_level_value =
        serde_json::to_value(top_level).expect("serialize top-level permission request");
    assert!(top_level_value.get("delegation").is_none());

    let partial_delegation = PermissionRequest {
        delegation: Some(PermissionDelegationContext {
            parent_dialog_turn_id: None,
            ..request.delegation.expect("delegation should exist")
        }),
        ..request
    };
    let partial_value =
        serde_json::to_value(partial_delegation).expect("serialize partial permission delegation");
    assert_eq!(
        partial_value["delegation"]["parentSessionId"],
        "parent-session-1"
    );
    assert!(partial_value["delegation"]
        .get("parentDialogTurnId")
        .is_none());
}

#[test]
fn permission_request_events_use_camel_case_fields() {
    assert_eq!(
        serde_json::to_value(PermissionRequestEvent::Replied {
            request_id: "request-1".to_string(),
            reply: PermissionReply::Once,
            source: PermissionReplySource::AutoApprove,
        })
        .expect("serialize replied permission event"),
        json!({
            "event": "replied",
            "requestId": "request-1",
            "reply": { "reply": "once" },
            "source": "auto_approve",
        })
    );
    assert_eq!(
        serde_json::to_value(PermissionRequestEvent::Cancelled {
            request_id: "request-2".to_string(),
            reason: "session closed".to_string(),
        })
        .expect("serialize cancelled permission event"),
        json!({
            "event": "cancelled",
            "requestId": "request-2",
            "reason": "session closed",
        })
    );
}

#[test]
fn wildcard_matching_supports_star_question_and_normalized_separators() {
    let sensitive = PermissionResourceCaseSensitivity::Sensitive;

    assert!(wildcard_matches("src/main.rs", "src/*.rs", sensitive));
    assert!(wildcard_matches("src/main.rs", "src/mai?.rs", sensitive));
    assert!(wildcard_matches(
        r"src\nested\main.rs",
        "src/*/main.rs",
        sensitive
    ));
    assert!(wildcard_matches("git", "git *", sensitive));
    assert!(wildcard_matches("git status", "git *", sensitive));
    assert!(!wildcard_matches("src/main.ts", "src/*.rs", sensitive));
    assert!(!wildcard_matches(
        "src/deep/main.rs",
        "src/????.rs",
        sensitive
    ));
}

#[test]
fn windows_compatible_matching_is_case_insensitive_for_resources() {
    let evaluator = PermissionEvaluator::windows_compatible();
    let rules = vec![rule(
        "read",
        r"C:\Users\Developer\Project\*",
        PermissionEffect::Allow,
    )];

    assert_eq!(
        evaluator.evaluate_resource("read", r"c:\users\developer\project\SRC\main.rs", &rules,),
        PermissionEffect::Allow
    );
    assert_eq!(
        PermissionEvaluator::case_sensitive().evaluate_resource(
            "read",
            r"c:\users\developer\project\SRC\main.rs",
            &rules,
        ),
        PermissionEffect::Ask
    );
}

#[test]
fn last_matching_action_and_resource_rule_wins() {
    let evaluator = PermissionEvaluator::case_sensitive();
    let rules = vec![
        rule("*", "*", PermissionEffect::Ask),
        rule("read", "src/*", PermissionEffect::Allow),
        rule("read", "src/private/*", PermissionEffect::Deny),
        rule("read", "src/private/public.txt", PermissionEffect::Allow),
    ];

    assert_eq!(
        evaluator.evaluate_resource("read", "src/lib.rs", &rules),
        PermissionEffect::Allow
    );
    assert_eq!(
        evaluator.evaluate_resource("read", "src/private/key.txt", &rules),
        PermissionEffect::Deny
    );
    assert_eq!(
        evaluator.evaluate_resource("read", "src/private/public.txt", &rules),
        PermissionEffect::Allow
    );
    assert_eq!(
        evaluator.evaluate_resource("edit", "src/lib.rs", &rules),
        PermissionEffect::Ask
    );
}

#[test]
fn merged_layers_preserve_global_project_agent_override_order() {
    let global = vec![rule("*", "*", PermissionEffect::Ask)];
    let project = vec![rule("read", "*", PermissionEffect::Allow)];
    let agent = vec![rule("read", "secrets/*", PermissionEffect::Deny)];
    let merged = merge_permission_rule_layers(&[&global, &project, &agent]);
    let evaluator = PermissionEvaluator::case_sensitive();

    assert_eq!(merged, [global, project, agent].concat());
    assert_eq!(
        evaluator.evaluate_resource("read", "README.md", &merged),
        PermissionEffect::Allow
    );
    assert_eq!(
        evaluator.evaluate_resource("read", "secrets/token.txt", &merged),
        PermissionEffect::Deny
    );
}

#[test]
fn unmatched_and_empty_resource_requests_default_to_ask() {
    let evaluator = PermissionEvaluator::case_sensitive();
    let rules = vec![rule("read", "src/*", PermissionEffect::Allow)];

    assert_eq!(
        evaluator.evaluate_resource("edit", "src/lib.rs", &rules),
        PermissionEffect::Ask
    );
    assert_eq!(
        evaluator.evaluate_resources("read", &[], &rules),
        PermissionEffect::Ask
    );
}

#[test]
fn multi_resource_decision_is_atomic_with_deny_then_ask_precedence() {
    let evaluator = PermissionEvaluator::case_sensitive();
    let rules = vec![
        rule("edit", "src/*", PermissionEffect::Allow),
        rule("edit", "src/generated/*", PermissionEffect::Ask),
        rule("edit", "src/secrets/*", PermissionEffect::Deny),
    ];

    assert_eq!(
        evaluator.evaluate_resources("edit", &["src/lib.rs".into(), "src/main.rs".into()], &rules,),
        PermissionEffect::Allow
    );
    assert_eq!(
        evaluator.evaluate_resources(
            "edit",
            &["src/lib.rs".into(), "src/generated/api.rs".into()],
            &rules,
        ),
        PermissionEffect::Ask
    );
    assert_eq!(
        evaluator.evaluate_resources(
            "edit",
            &["src/generated/api.rs".into(), "src/secrets/key.rs".into(),],
            &rules,
        ),
        PermissionEffect::Deny
    );
}

#[test]
fn permission_mode_projects_onto_preset_and_auto_approval() {
    assert_eq!(PermissionMode::Ask.preset(), PermissionPolicyPreset::Ask);
    assert!(!PermissionMode::Ask.auto_approve_ask());

    assert_eq!(
        PermissionMode::AutoApprove.preset(),
        PermissionPolicyPreset::Ask
    );
    assert!(PermissionMode::AutoApprove.auto_approve_ask());

    assert_eq!(
        PermissionMode::FullAccess.preset(),
        PermissionPolicyPreset::FullAccess
    );
    assert!(!PermissionMode::FullAccess.auto_approve_ask());
}

#[test]
fn permission_mode_round_trips_through_stored_configuration() {
    let mut config = ToolPermissionConfig::default();
    assert_eq!(
        PermissionMode::from_config(&config),
        PermissionMode::FullAccess
    );

    config.policy.preset = PermissionPolicyPreset::Ask;
    assert_eq!(PermissionMode::from_config(&config), PermissionMode::Ask);

    config.interaction.auto_approve_ask = true;
    assert_eq!(
        PermissionMode::from_config(&config),
        PermissionMode::AutoApprove
    );

    // Full access already resolves every ask, so it outranks auto approval.
    config.policy.preset = PermissionPolicyPreset::FullAccess;
    assert_eq!(
        PermissionMode::from_config(&config),
        PermissionMode::FullAccess
    );

    for mode in [
        PermissionMode::Ask,
        PermissionMode::AutoApprove,
        PermissionMode::FullAccess,
    ] {
        assert_eq!(PermissionMode::parse(mode.as_str()), Some(mode));
    }
    assert_eq!(
        PermissionMode::parse("auto"),
        Some(PermissionMode::AutoApprove)
    );
    assert_eq!(
        PermissionMode::parse("  Full  "),
        Some(PermissionMode::FullAccess)
    );
    assert_eq!(PermissionMode::parse("elevated"), None);
}

#[test]
fn permission_mode_resolution_prefers_the_narrowest_layer() {
    let base = PermissionModeLayers::new(PermissionMode::Ask);

    let global_only = resolve_permission_mode(base);
    assert_eq!(global_only.mode, PermissionMode::Ask);
    assert_eq!(global_only.source, PermissionModeSource::GlobalDefault);

    let session = resolve_permission_mode(base.with_session(Some(PermissionMode::FullAccess)));
    assert_eq!(session.mode, PermissionMode::FullAccess);
    assert_eq!(session.source, PermissionModeSource::Session);

    let turn = resolve_permission_mode(
        base.with_session(Some(PermissionMode::FullAccess))
            .with_turn(Some(PermissionMode::Ask)),
    );
    assert_eq!(turn.mode, PermissionMode::Ask);
    assert_eq!(turn.source, PermissionModeSource::Turn);

    let project = resolve_permission_mode(PermissionModeLayers {
        project: Some(PermissionMode::AutoApprove),
        ..base
    });
    assert_eq!(project.mode, PermissionMode::AutoApprove);
    assert_eq!(project.source, PermissionModeSource::Project);
}

#[test]
fn full_access_mode_stays_bounded_by_project_and_enforced_layers() {
    let global = policy(PermissionPolicyPreset::Ask, Vec::new());
    let project = vec![rule("edit", "generated/*", PermissionEffect::Deny)];
    let enforced = vec![rule("bash", "rm *", PermissionEffect::Deny)];

    let resolved = resolve_permission_policy(PermissionPolicyLayers {
        product_defaults: &[],
        global: &global,
        mode: Some(PermissionMode::FullAccess),
        project: &project,
        agent: &[],
        enforced: &enforced,
    });
    let evaluator = PermissionEvaluator::case_sensitive();

    // The mode raises the baseline...
    assert_eq!(
        evaluator.evaluate_policy_resource("edit", "src/main.rs", &resolved),
        PermissionEffect::Allow
    );
    // ...but never past a later deny layer.
    assert_eq!(
        evaluator.evaluate_policy_resource("edit", "generated/api.rs", &resolved),
        PermissionEffect::Deny
    );
    assert_eq!(
        evaluator.evaluate_policy_resource("bash", "rm -rf target", &resolved),
        PermissionEffect::Deny
    );
}

#[test]
fn inherited_full_access_mode_cannot_widen_a_parent_runtime_ceiling() {
    let global = policy(PermissionPolicyPreset::Ask, Vec::new());
    let ceiling = PermissionRuntimeCeiling::try_new(vec![
        rule("bash", "rm *", PermissionEffect::Deny),
        rule("external_directory", "*", PermissionEffect::Ask),
    ])
    .expect("ceiling without allow rules should be valid");

    let resolved = resolve_child_permission_policy(ChildPermissionPolicyLayers {
        product_defaults: &[],
        global: &global,
        mode: Some(PermissionMode::FullAccess),
        project: &[],
        child_agent: &[],
        parent_runtime_ceiling: &ceiling,
        enforced: &[],
    });
    let evaluator = PermissionEvaluator::case_sensitive();

    assert_eq!(
        evaluator.evaluate_policy_resource("edit", "src/main.rs", &resolved),
        PermissionEffect::Allow
    );
    assert_eq!(
        evaluator.evaluate_policy_resource("bash", "rm -rf target", &resolved),
        PermissionEffect::Deny
    );
    assert_eq!(
        evaluator.evaluate_policy_resource("external_directory", "C:/outside", &resolved),
        PermissionEffect::Ask
    );
}

#[test]
fn omitted_mode_keeps_the_stored_global_preset() {
    let global = policy(PermissionPolicyPreset::FullAccess, Vec::new());

    let resolved = resolve_permission_policy(PermissionPolicyLayers {
        product_defaults: &[],
        global: &global,
        mode: None,
        project: &[],
        agent: &[],
        enforced: &[],
    });

    assert_eq!(
        PermissionEvaluator::case_sensitive().evaluate_policy_resource(
            "edit",
            "src/main.rs",
            &resolved
        ),
        PermissionEffect::Allow
    );
}

#[derive(Debug, serde::Deserialize, serde::Serialize, PartialEq, Eq)]
struct PersistedModeCarrier {
    #[serde(
        default,
        deserialize_with = "openbitfun_product_domains::tool_permissions::deserialize_optional_permission_mode",
        skip_serializing_if = "Option::is_none"
    )]
    permission_mode: Option<PermissionMode>,
    keep: String,
}

#[test]
fn persisted_permission_mode_reads_every_known_value() {
    for (stored, expected) in [
        ("ask", PermissionMode::Ask),
        ("auto_approve", PermissionMode::AutoApprove),
        ("full_access", PermissionMode::FullAccess),
    ] {
        let carrier: PersistedModeCarrier = serde_json::from_value(json!({
            "permission_mode": stored,
            "keep": "value",
        }))
        .expect("known mode should deserialize");
        assert_eq!(carrier.permission_mode, Some(expected));
    }
}

#[test]
fn persisted_permission_mode_degrades_instead_of_failing_the_record() {
    // A value written by a newer build, a null, and a wrong type must all leave
    // the surrounding record readable. Failing here would take the whole
    // persisted session state down with one unknown field.
    for stored in [
        json!("read_only"),
        json!(null),
        json!(7),
        json!({"mode": "ask"}),
    ] {
        let carrier: PersistedModeCarrier = serde_json::from_value(json!({
            "permission_mode": stored,
            "keep": "value",
        }))
        .expect("an unreadable mode must not fail the record");
        assert_eq!(carrier.permission_mode, None);
        assert_eq!(carrier.keep, "value");
    }

    // An absent field is the ordinary "follows the user-level default" case.
    let carrier: PersistedModeCarrier =
        serde_json::from_value(json!({ "keep": "value" })).expect("absent mode is valid");
    assert_eq!(carrier.permission_mode, None);
}

#[test]
fn unset_permission_mode_is_omitted_so_old_builds_see_unchanged_files() {
    let omitted = serde_json::to_value(PersistedModeCarrier {
        permission_mode: None,
        keep: "value".to_string(),
    })
    .expect("serialize");
    assert_eq!(omitted, json!({ "keep": "value" }));

    let written = serde_json::to_value(PersistedModeCarrier {
        permission_mode: Some(PermissionMode::FullAccess),
        keep: "value".to_string(),
    })
    .expect("serialize");
    assert_eq!(
        written,
        json!({ "permission_mode": "full_access", "keep": "value" })
    );
}

#[test]
fn stored_permission_preferences_survive_default_change() {
    for preset in ["ask", "full_access"] {
        for auto_approve in [false, true] {
            let stored = json!({
                "policy": { "preset": preset, "rules": [] },
                "interaction": { "auto_approve_ask": auto_approve }
            });
            let config: ToolPermissionConfig = serde_json::from_value(stored.clone()).unwrap();
            assert_eq!(serde_json::to_value(config).unwrap(), stored);
        }
    }
    let missing: ToolPermissionConfig = serde_json::from_value(json!({})).unwrap();
    assert_eq!(
        PermissionMode::from_config(&missing),
        PermissionMode::FullAccess
    );
}

#[test]
fn approval_configuration_is_additive_and_validates_model_bindings() {
    let legacy: ToolPermissionConfig = serde_json::from_value(json!({
        "policy": {"preset": "ask", "rules": []},
        "interaction": {"auto_approve_ask": false}
    }))
    .unwrap();
    assert_eq!(
        legacy.approval.strategy,
        PermissionApprovalStrategy::Interactive
    );
    assert_eq!(
        legacy.approval.model_kind,
        PermissionApprovalModelKind::Chat
    );
    assert_eq!(legacy.approval.chat_model_id, "fast");
    assert_eq!(legacy.approval.timeout_ms, 30_000);

    // Legacy auto-approval settings resolve to model approval at runtime.
    let legacy_auto: ToolPermissionConfig = serde_json::from_value(json!({
        "policy": {"preset": "ask", "rules": []},
        "interaction": {"auto_approve_ask": true}
    }))
    .unwrap();
    assert_eq!(legacy_auto.approval.chat_model_id, "fast");
    let mut model_approval = legacy_auto.approval.clone();
    model_approval.strategy = PermissionApprovalStrategy::Model;
    assert!(model_approval.validate().is_ok());

    let configured: ToolPermissionConfig = serde_json::from_value(json!({
        "policy": {"preset": "ask", "rules": []},
        "interaction": {"auto_approve_ask": false},
        "approval": {
            "strategy": "model",
            "model_kind": "chat",
            "chat_model_id": "approval-model",
            "timeout_ms": 12000,
            "on_ask": "user",
            "on_error": "reject"
        }
    }))
    .unwrap();
    assert_eq!(
        configured.approval.strategy,
        PermissionApprovalStrategy::Model
    );
    assert_eq!(
        configured.approval.model_kind,
        PermissionApprovalModelKind::Chat
    );
    assert_eq!(configured.approval.on_ask, PermissionApprovalOnAsk::User);
    assert_eq!(
        configured.approval.on_error,
        PermissionApprovalOnError::Reject
    );
    assert!(configured.approval.validate().is_ok());
    let serialized_approval = serde_json::to_value(&configured.approval).unwrap();
    assert_eq!(serialized_approval["model_kind"], "chat");
    assert_eq!(serialized_approval["chat_model_id"], "approval-model");
    assert!(serialized_approval.get("model").is_none());
    assert!(serialized_approval.get("headless_fallback").is_none());
    let mut invalid = configured.approval.clone();
    invalid.chat_model_id.clear();
    assert!(invalid.validate().is_err());

    let decision_model_without_chat_model_id =
        serde_json::from_value::<ToolPermissionConfig>(json!({
            "approval": {
                "strategy": "model",
                "model_kind": "decision",
                "chat_model_id": "",
                "timeout_ms": 30000,
                "on_ask": "user",
                "on_error": "ask"
            }
        }))
        .unwrap();
    assert!(decision_model_without_chat_model_id
        .approval
        .validate()
        .is_ok());
}
