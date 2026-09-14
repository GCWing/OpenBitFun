use std::collections::HashSet;
use std::path::PathBuf;

use openbitfun_agent_runtime::skills::{
    annotate_shadowed_skills, build_mode_skill_infos, builtin_skill_group_key,
    filter_candidates_for_mode, filter_implicitly_invocable_skills, filter_user_invocable_skills,
    is_skill_globally_enabled, render_loaded_skill_for_assistant, resolve_builtin_default_enabled,
    resolve_default_hidden_builtin_for_explicit_invocation, resolve_skill_default_enabled_for_mode,
    resolve_skill_state_for_mode, resolve_user_config_skill_root, resolve_visible_skills,
    sort_skills, ExplicitSkillInvocationResolution, ModeSkillStateReason, SkillCandidate,
    SkillData, SkillInfo, SkillLocation, SkillParseError, UserModeSkillOverrides,
    OPENBITFUN_SYSTEM_SKILL_DIR, OPENBITFUN_SYSTEM_SKILL_SLOT, OPENBITFUN_USER_SKILL_SLOT,
    PROJECT_SKILL_KEY_PREFIX, PROJECT_SKILL_ROOTS, USER_CONFIG_SKILL_ROOTS, USER_HOME_SKILL_ROOTS,
    USER_SKILL_KEY_PREFIX,
};

fn builtin_skill(dir_name: &str) -> SkillInfo {
    SkillInfo {
        key: format!("user::openbitfun-system::{}", dir_name),
        name: dir_name.to_string(),
        description: String::new(),
        path: format!("/tmp/{}", dir_name),
        level: SkillLocation::User,
        source_slot: "openbitfun-system".to_string(),
        source_id: "openbitfun".to_string(),
        source_label: "OpenBitFun".to_string(),
        installation_source: None,
        import_origin: None,
        entry_file: None,
        dir_name: dir_name.to_string(),
        is_builtin: true,
        group_key: builtin_skill_group_key(dir_name).map(str::to_string),
        is_shadowed: false,
        shadowed_by_key: None,
        allow_implicit_invocation: true,
        allow_user_invocation: true,
        argument_hint: None,
    }
}

fn custom_user_skill(dir_name: &str) -> SkillInfo {
    SkillInfo {
        key: format!("user::openbitfun::{}", dir_name),
        name: dir_name.to_string(),
        description: String::new(),
        path: format!("/tmp/{}", dir_name),
        level: SkillLocation::User,
        source_slot: "openbitfun".to_string(),
        source_id: "openbitfun".to_string(),
        source_label: "OpenBitFun".to_string(),
        installation_source: None,
        import_origin: None,
        entry_file: None,
        dir_name: dir_name.to_string(),
        is_builtin: false,
        group_key: None,
        is_shadowed: false,
        shadowed_by_key: None,
        allow_implicit_invocation: true,
        allow_user_invocation: true,
        argument_hint: None,
    }
}

#[test]
fn skill_installation_source_is_optional_for_legacy_payloads_and_round_trips() {
    let original = custom_user_skill("eli5");
    let legacy = serde_json::to_value(&original).unwrap();
    assert!(legacy.get("installationSource").is_none());
    let mut decoded: SkillInfo = serde_json::from_value(legacy.clone()).unwrap();
    assert!(decoded.installation_source.is_none());
    assert_eq!(serde_json::to_value(&decoded).unwrap(), legacy);
    decoded.installation_source = Some("first/skills".into());
    let current: SkillInfo =
        serde_json::from_value(serde_json::to_value(decoded).unwrap()).unwrap();
    assert_eq!(current.installation_source.as_deref(), Some("first/skills"));
}

#[test]
fn import_origin_round_trips_without_changing_native_ownership_or_legacy_payloads() {
    let legacy = serde_json::to_value(custom_user_skill("demo")).unwrap();
    assert!(legacy.get("importOrigin").is_none());
    let mut skill: SkillInfo = serde_json::from_value(legacy.clone()).unwrap();
    assert_eq!(serde_json::to_value(&skill).unwrap(), legacy);
    skill.import_origin = Some(openbitfun_agent_runtime::skills::SkillImportOrigin {
        schema_version: 1,
        import_id: "import-1".into(),
        source_key: "user::home.claude::demo".into(),
        source_path: "/external/demo".into(),
        source_id: "claude-code".into(),
        source_label: "Claude Code".into(),
        source_slot: "home.claude".into(),
        fingerprint: "fixture-hash".into(),
    });
    let decoded: SkillInfo = serde_json::from_value(serde_json::to_value(&skill).unwrap()).unwrap();
    assert_eq!(decoded.import_origin, skill.import_origin);
    assert_eq!(decoded.source_id, "openbitfun");
    assert_eq!(decoded.parser_source_slot(), "home.claude");
    assert!(decoded.is_native());
}

#[test]
fn native_ownership_rejects_discovery_sources_and_honors_legacy_slots() {
    for source in [
        "claude-code",
        "codex",
        "cursor",
        "opencode",
        "agent-skills",
        "deepseek-harness",
        "pi",
    ] {
        let mut skill = custom_user_skill("external");
        skill.source_id = source.into();
        assert!(!skill.is_native(), "{source}");
    }
    for (slot, expected) in [
        ("openbitfun", true),
        ("openbitfun-system", true),
        ("home.claude", false),
        ("codex", false),
    ] {
        let mut legacy = serde_json::to_value(custom_user_skill("legacy")).unwrap();
        legacy.as_object_mut().unwrap().remove("sourceId");
        legacy.as_object_mut().unwrap().remove("sourceLabel");
        legacy["sourceSlot"] = slot.into();
        let decoded: SkillInfo = serde_json::from_value(legacy).unwrap();
        assert_eq!(decoded.is_native(), expected, "{slot}");
        let round_trip: SkillInfo =
            serde_json::from_value(serde_json::to_value(decoded).unwrap()).unwrap();
        assert_eq!(round_trip.is_native(), expected);
    }
}

#[test]
fn skill_source_dialect_is_derived_from_the_stable_source_slot() {
    let markdown = "---\ndescription: Directory fallback.\n---\n\nBody.\n";
    for source_slot in ["claude", "home.claude", "codex", "home.codex"] {
        let parsed = SkillData::from_markdown_for_source_slot(
            "/workspace/root/slot-fallback".to_string(),
            markdown,
            SkillLocation::Project,
            false,
            source_slot,
        )
        .unwrap_or_else(|error| panic!("unexpected dialect for {source_slot}: {error}"));
        assert_eq!(parsed.name, "slot-fallback");
    }
    for source_slot in ["openbitfun", "cursor", "opencode", "agents"] {
        assert!(SkillData::from_markdown_for_source_slot(
            "/workspace/root/strict".to_string(),
            markdown,
            SkillLocation::Project,
            false,
            source_slot,
        )
        .is_err());
    }
}

#[test]
fn claude_skill_uses_directory_identity_and_static_metadata_fallbacks() {
    let markdown = r#"---
name: ignored-display-name
when_to_use: Use for focused security reviews.
arguments:
  - target
  - focus
allowed-tools: Read, Grep
---

Review a change without modifying it.

Additional workflow details.
"#;

    let data = SkillData::from_markdown_for_source_slot(
        "/workspace/.claude/skills/security-review".to_string(),
        markdown,
        SkillLocation::Project,
        true,
        "claude",
    )
    .expect("supported Claude skill should parse");

    assert_eq!(data.name, "security-review");
    assert!(data
        .description
        .starts_with("Review a change without modifying it."));
    assert!(data
        .description
        .contains("Use for focused security reviews."));
    assert!(data.description.chars().count() <= 1536);
    assert_eq!(data.argument_names, ["target", "focus"]);
    assert!(data.content.contains("Additional workflow details."));
}

#[test]
fn claude_skill_accepts_whitespace_argument_names_and_explicit_description() {
    let markdown = r#"---
description: Deploy a selected service.
arguments: service environment
---

Deploy $service to $environment.
"#;

    let data = SkillData::from_markdown_for_source_slot(
        "/workspace/.claude/skills/deploy".to_string(),
        markdown,
        SkillLocation::Project,
        true,
        "claude",
    )
    .expect("Claude string arguments should parse");

    assert_eq!(data.name, "deploy");
    assert_eq!(data.description, "Deploy a selected service.");
    assert_eq!(data.argument_names, ["service", "environment"]);
}

#[test]
fn claude_when_to_use_cannot_replace_a_missing_description() {
    let error = SkillData::from_markdown_for_source_slot(
        "/workspace/.claude/skills/empty".to_string(),
        "---\nwhen_to_use: Use for empty inputs.\n---\n",
        SkillLocation::Project,
        false,
        "claude",
    )
    .expect_err("when_to_use only supplements a description");

    assert_eq!(error, SkillParseError::MissingField("description"));
}

#[test]
fn claude_skill_rejects_unavailable_runtime_semantics() {
    for field in [
        "context: fork",
        "agent: Explore",
        "hooks: {}",
        "paths: src/**",
        "shell: bash",
        "runtime: node",
        "background: true",
        "disallowed-tools: Write",
    ] {
        let markdown =
            format!("---\ndescription: Unsupported behavior.\n{field}\n---\n\nDo work.\n");
        let error = SkillData::from_markdown_for_source_slot(
            "/workspace/.claude/skills/unsafe".to_string(),
            &markdown,
            SkillLocation::Project,
            true,
            "claude",
        )
        .expect_err("unsupported Claude behavior must fail closed");
        assert!(matches!(error, SkillParseError::InvalidFormat(_)));
    }
}

#[test]
fn claude_dynamic_content_loads_unchanged_with_compatibility_notes() {
    for body in [
        "Use ${CLAUDE_SESSION_ID}.",
        "Use ${CLAUDE_EFFORT}.",
        "Read ${CLAUDE_SKILL_DIR}/data.",
        "Run !`git status` before continuing.",
        "!`git diff`",
        "Read ${CLAUDE_PROJECT_DIR}/data.",
        "```!\ngit status\n```",
    ] {
        let markdown = format!("---\ndescription: Dynamic behavior.\n---\n\n{body}");
        for slot in ["claude", "home.claude"] {
            let skill = SkillData::from_markdown_for_source_slot(
                "/workspace/.claude/skills/dynamic".to_string(),
                &markdown,
                SkillLocation::Project,
                true,
                slot,
            )
            .expect("dynamic content should load without executing or expanding it");
            assert_eq!(skill.content, body);
            assert_eq!(skill.compatibility_warnings.len(), 1);
            for stable_key in [false, true] {
                let rendered = render_loaded_skill_for_assistant(&skill, stable_key);
                assert!(rendered.contains(&skill.compatibility_warnings[0]));
                assert!(rendered.contains(&format!("<skill_content>\n{body}\n</skill_content>")));
            }
            let discovery = SkillData::from_markdown_for_source_slot(
                skill.path.clone(),
                &markdown,
                SkillLocation::Project,
                false,
                slot,
            )
            .unwrap();
            assert!(discovery.content.is_empty());
            assert_eq!(
                discovery.compatibility_warnings,
                skill.compatibility_warnings
            );
        }
    }
}

#[test]
fn claude_excel_punctuation_and_non_command_backticks_need_no_fallback() {
    let body = "Cross-sheet `!` references: `Sheet1!A1`. Errors: `#REF!`, `#DIV/0!`, `#VALUE!`.\nKEY=!`cmd`\nUnclosed !`command\nHello!";
    for slot in ["claude", "home.claude"] {
        let skill = SkillData::from_markdown_for_source_slot(
            "/skills/officecli-xlsx".into(),
            &format!("---\nname: officecli-xlsx\ndescription: Excel workflows.\n---\n{body}"),
            SkillLocation::User,
            true,
            slot,
        )
        .unwrap();
        assert_eq!(skill.content, body);
        assert!(skill.compatibility_warnings.is_empty());
    }
}

#[test]
fn claude_preferences_degrade_without_bypassing_execution_constraints() {
    let markdown = "---\ndescription: Review.\nmodel: opus\neffort: high\ndisable-model-invocation: true\nuser-invocable: false\n---\nReview.";
    let skill = SkillData::from_markdown_for_source_slot(
        "/skills/review".into(),
        markdown,
        SkillLocation::User,
        true,
        "home.claude",
    )
    .unwrap();
    assert_eq!(skill.compatibility_warnings.len(), 2);
    assert!(!skill.allow_implicit_invocation);
    assert!(!skill.allow_user_invocation);
    assert_eq!(skill.content, "Review.");
    let restricted = markdown.replace("model: opus", "model: opus\ndisallowed-tools: Write");
    assert!(SkillData::from_markdown_for_source_slot(
        "/skills/review".into(),
        &restricted,
        SkillLocation::User,
        true,
        "home.claude",
    )
    .is_err());
    let generic = SkillData::from_markdown_for_source_slot(
        "/skills/review".into(),
        &markdown.replace("description:", "name: review\ndescription:"),
        SkillLocation::User,
        true,
        "openbitfun",
    )
    .unwrap();
    assert!(generic.compatibility_warnings.is_empty());
}

#[test]
fn claude_skill_validates_argument_names_without_a_generic_schema() {
    for arguments in [
        "arguments: target target",
        "arguments: target/path",
        "arguments:\n  - target\n  - 42",
    ] {
        let markdown = format!("---\ndescription: Invalid arguments.\n{arguments}\n---\n\nBody.\n");
        assert!(SkillData::from_markdown_for_source_slot(
            "/workspace/.claude/skills/invalid-arguments".to_string(),
            &markdown,
            SkillLocation::Project,
            false,
            "claude",
        )
        .is_err());
    }
}

#[test]
fn codex_skill_falls_back_to_directory_name_but_keeps_description_required() {
    let data = SkillData::from_markdown_for_source_slot(
        "/workspace/.codex/skills/review".to_string(),
        "---\ndescription: Review a change.\n---\n\nReview carefully.\n",
        SkillLocation::Project,
        true,
        "codex",
    )
    .expect("Codex skill should use its directory name");
    assert_eq!(data.name, "review");
    assert_eq!(data.description, "Review a change.");

    let missing_description = SkillData::from_markdown_for_source_slot(
        "/workspace/.codex/skills/review".to_string(),
        "---\nname: review\n---\n\nReview carefully.\n",
        SkillLocation::Project,
        false,
        "codex",
    )
    .expect_err("Codex description remains required");
    assert_eq!(
        missing_description,
        SkillParseError::MissingField("description")
    );

    let strict = SkillData::from_markdown(
        "/workspace/.agents/skills/review".to_string(),
        "---\ndescription: Review a change.\n---\n\nReview carefully.\n",
        SkillLocation::Project,
        false,
    )
    .expect_err("Agent Skills roots keep strict name requirements");
    assert_eq!(strict, SkillParseError::MissingField("name"));
}

fn project_skill(dir_name: &str) -> SkillInfo {
    SkillInfo {
        key: format!("project::openbitfun::{}", dir_name),
        name: dir_name.to_string(),
        description: String::new(),
        path: format!("/workspace/.openbitfun/skills/{}", dir_name),
        level: SkillLocation::Project,
        source_slot: "openbitfun".to_string(),
        source_id: "openbitfun".to_string(),
        source_label: "OpenBitFun".to_string(),
        installation_source: None,
        import_origin: None,
        entry_file: None,
        dir_name: dir_name.to_string(),
        is_builtin: false,
        group_key: None,
        is_shadowed: false,
        shadowed_by_key: None,
        allow_implicit_invocation: true,
        allow_user_invocation: true,
        argument_hint: None,
    }
}

#[test]
fn builtin_skill_catalog_and_mode_policy_are_runtime_owned() {
    assert_eq!(builtin_skill_group_key("create-agent"), Some("meta"));
    for mode in ["Standard", "Creative", "Cowork", "DeepResearch"] {
        assert_eq!(
            resolve_builtin_default_enabled("create-agent", mode),
            Some(true)
        );
    }
    for mode in ["Ultimate", "SwarmWorker"] {
        assert_eq!(
            resolve_builtin_default_enabled("create-agent", mode),
            Some(false)
        );
    }
    assert_eq!(builtin_skill_group_key("ppt-design"), Some("office"));
    for removed in ["docx", "pdf", "pptx", "xlsx"] {
        assert_eq!(builtin_skill_group_key(removed), None);
    }
    assert_eq!(
        builtin_skill_group_key("create-openbitfun-skin"),
        Some("meta")
    );
    assert_eq!(builtin_skill_group_key("find-skills"), Some("meta"));
    assert_eq!(builtin_skill_group_key("miniapp-dev"), Some("miniapp"));
    assert_eq!(
        builtin_skill_group_key("openbitfun-frontend-dev"),
        Some("creation")
    );
    assert_eq!(
        builtin_skill_group_key("agent-browser"),
        Some("computer-use")
    );
    assert_eq!(builtin_skill_group_key("agent-eval-canvas"), Some("canvas"));
    assert_eq!(builtin_skill_group_key("openbitfun-canvas"), Some("canvas"));
    assert_eq!(builtin_skill_group_key("pr-review-canvas"), Some("canvas"));
    assert_eq!(builtin_skill_group_key("docs-canvas"), Some("canvas"));
    assert_eq!(builtin_skill_group_key("multitask"), Some("coordination"));
    assert_eq!(builtin_skill_group_key("plan"), Some("planning"));
    assert_eq!(builtin_skill_group_key("gstack-review"), Some("gstack"));
    assert_eq!(builtin_skill_group_key("unknown-skill"), None);

    assert_eq!(
        resolve_builtin_default_enabled("ppt-design", "Standard"),
        Some(false)
    );
    assert_eq!(
        resolve_builtin_default_enabled("ppt-design", "Cowork"),
        Some(true)
    );
    assert_eq!(
        resolve_builtin_default_enabled("create-openbitfun-skin", "DeepResearch"),
        Some(true)
    );
    assert_eq!(
        resolve_builtin_default_enabled("find-skills", "DeepResearch"),
        Some(true)
    );
    assert_eq!(
        resolve_builtin_default_enabled("miniapp-dev", "Standard"),
        Some(false)
    );
    assert_eq!(
        resolve_builtin_default_enabled("miniapp-dev", "Cowork"),
        Some(false)
    );
    assert_eq!(
        resolve_builtin_default_enabled("miniapp-dev", "DeepResearch"),
        Some(false)
    );
    assert_eq!(
        resolve_builtin_default_enabled("miniapp-dev", "Creative"),
        Some(true)
    );
    assert_eq!(
        resolve_builtin_default_enabled("openbitfun-frontend-dev", "Creative"),
        Some(true)
    );
    assert_eq!(
        resolve_builtin_default_enabled("openbitfun-frontend-dev", "Standard"),
        Some(false)
    );
    assert_eq!(
        resolve_builtin_default_enabled("agent-browser", "Standard"),
        Some(false)
    );
    assert_eq!(
        resolve_builtin_default_enabled("agent-browser", "Ultimate"),
        Some(true)
    );
    assert_eq!(
        resolve_builtin_default_enabled("plan", "Ultimate"),
        Some(true)
    );
    assert_eq!(
        resolve_builtin_default_enabled("find-skills", "Ultimate"),
        Some(false)
    );
    assert_eq!(
        resolve_builtin_default_enabled("agent-browser", "SwarmWorker"),
        Some(true)
    );
    assert_eq!(
        resolve_builtin_default_enabled("plan", "SwarmWorker"),
        Some(false)
    );
    for (mode_id, expected) in [
        ("Standard", true),
        ("Cowork", true),
        ("Creative", true),
        ("DeepResearch", true),
        ("ComputerUse", false),
    ] {
        assert_eq!(
            resolve_builtin_default_enabled("multitask", mode_id),
            Some(expected),
            "unexpected multitask default for {mode_id}"
        );
    }
    for (mode_id, expected) in [
        ("Standard", true),
        ("Standard", true),
        ("Claw", true),
        ("Cowork", true),
        ("Creative", true),
        ("ComputerUse", false),
        ("DeepResearch", false),
    ] {
        assert_eq!(
            resolve_builtin_default_enabled("plan", mode_id),
            Some(expected),
            "unexpected plan default for {mode_id}"
        );
    }
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
            "Cowork",
            "Creative",
            "ComputerUse",
            "DeepResearch",
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
fn skill_discovery_root_facts_are_runtime_owned() {
    assert_eq!(USER_SKILL_KEY_PREFIX, "user");
    assert_eq!(PROJECT_SKILL_KEY_PREFIX, "project");
    assert_eq!(OPENBITFUN_USER_SKILL_SLOT, "openbitfun");
    assert_eq!(OPENBITFUN_SYSTEM_SKILL_SLOT, "openbitfun-system");
    assert_eq!(OPENBITFUN_SYSTEM_SKILL_DIR, ".system");

    let project_roots = PROJECT_SKILL_ROOTS
        .iter()
        .map(|root| (root.parent, root.slot, root.source_id, root.source_label))
        .collect::<Vec<_>>();
    assert_eq!(
        project_roots,
        [
            (".openbitfun", "openbitfun", "openbitfun", "OpenBitFun"),
            (".claude", "claude", "claude-code", "Claude Code"),
            (".codex", "codex", "codex", "Codex"),
            (".cursor", "cursor", "cursor", "Cursor"),
            (".opencode", "opencode", "opencode", "OpenCode"),
            (".agents", "agents", "agent-skills", "Agent Skills"),
            (".dsh", "dsh", "deepseek-harness", "DeepSeek Harness"),
            (".pi", "pi", "pi", "PI"),
        ]
    );

    let user_home_roots = USER_HOME_SKILL_ROOTS
        .iter()
        .map(|root| (root.parent, root.slot, root.source_id, root.source_label))
        .collect::<Vec<_>>();
    assert_eq!(
        user_home_roots,
        [
            (".claude", "home.claude", "claude-code", "Claude Code"),
            (".codex", "home.codex", "codex", "Codex"),
            (".cursor", "home.cursor", "cursor", "Cursor"),
            (".opencode", "home.opencode", "opencode", "OpenCode"),
            (".agents", "home.agents", "agent-skills", "Agent Skills"),
            (".dsh", "home.dsh", "deepseek-harness", "DeepSeek Harness"),
            (".pi/agent", "home.pi", "pi", "PI"),
        ]
    );
    assert_eq!(
        USER_CONFIG_SKILL_ROOTS
            .iter()
            .map(|root| (root.parent, root.slot, root.source_id, root.source_label))
            .collect::<Vec<_>>(),
        [("opencode", "config.opencode", "opencode", "OpenCode")]
    );
    assert!(!USER_CONFIG_SKILL_ROOTS
        .iter()
        .any(|root| root.parent == "agents"));
}

#[test]
fn skill_source_identity_is_serialized_without_changing_slot_identity() {
    let mut info = project_skill("pdf");
    info.source_id = "openbitfun".to_string();
    info.source_label = "OpenBitFun".to_string();
    info.allow_user_invocation = false;
    info.argument_hint = Some("[file]".to_string());

    let value = serde_json::to_value(info).expect("skill info should serialize");
    assert_eq!(value["sourceSlot"], "openbitfun");
    assert_eq!(value["sourceId"], "openbitfun");
    assert_eq!(value["sourceLabel"], "OpenBitFun");
    assert_eq!(value["allowUserInvocation"], false);
    assert_eq!(value["argumentHint"], "[file]");
}

#[test]
fn legacy_skill_payload_keeps_directory_entry_and_round_trips_without_new_fields() {
    let legacy = serde_json::to_value(project_skill("review")).unwrap();
    assert!(legacy.get("entryFile").is_none());
    let restored: SkillInfo = serde_json::from_value(legacy.clone()).unwrap();
    assert!(restored.entry_file.is_none());
    assert_eq!(serde_json::to_value(restored).unwrap(), legacy);
    let mut flat = legacy;
    flat["entryFile"] = serde_json::json!("review.md");
    let restored: SkillInfo = serde_json::from_value(flat.clone()).unwrap();
    assert_eq!(restored.entry_file.as_deref(), Some("review.md"));
    assert_eq!(serde_json::to_value(restored).unwrap(), flat);
}

#[test]
fn pi_name_fallback_and_dsh_invocation_metadata_follow_the_source_dialect() {
    let pi = SkillData::from_markdown_for_source_slot(
        "/project/.pi/skills".into(),
        "---\nname: 42\ndescription: PI skill\n---\nbody",
        SkillLocation::Project,
        true,
        "pi",
    )
    .unwrap();
    assert_eq!(pi.name, "skills");
    for content in [
        "---\nname: Bad_Name\ndescription: DSH\n---\nbody",
        "---\nname: good-name\ndescription: DSH\ndisableModelInvocation: true\n---\nbody",
    ] {
        assert!(SkillData::from_markdown_for_source_slot(
            "/project/.dsh/skills/review".into(),
            content,
            SkillLocation::Project,
            true,
            "dsh"
        )
        .is_err());
    }
}

#[test]
fn user_config_skill_root_resolution_matches_platform_contract() {
    let opencode = USER_CONFIG_SKILL_ROOTS
        .iter()
        .find(|root| root.parent == "opencode")
        .expect("opencode config root should exist");

    if cfg!(target_os = "windows") {
        let resolved = resolve_user_config_skill_root(
            opencode,
            std::path::Path::new(r"C:\Users\tester\AppData\Roaming"),
            Some(std::path::Path::new(r"C:\Users\tester")),
        );
        assert_eq!(
            resolved,
            PathBuf::from(r"C:\Users\tester\.config\opencode\skills")
        );
    } else {
        let resolved = resolve_user_config_skill_root(
            opencode,
            std::path::Path::new("/home/tester/.config"),
            Some(std::path::Path::new("/home/tester")),
        );
        assert_eq!(
            resolved,
            PathBuf::from("/home/tester/.config/opencode/skills")
        );
    }
}

#[test]
fn skill_resolution_applies_builtin_and_user_override_rules() {
    let presentation = builtin_skill("ppt-design");
    let custom = custom_user_skill("my-custom-skill");
    let disabled_project = HashSet::new();

    assert!(!resolve_skill_default_enabled_for_mode(
        &presentation,
        "Standard"
    ));
    assert!(resolve_skill_default_enabled_for_mode(&custom, "Standard"));

    let default_state = resolve_skill_state_for_mode(
        &presentation,
        "Standard",
        &UserModeSkillOverrides::default(),
        &disabled_project,
    );
    assert!(!default_state.effective_enabled);
    assert_eq!(
        default_state.reason,
        ModeSkillStateReason::BuiltinPolicyDisabled
    );

    let mut overrides = UserModeSkillOverrides::default();
    overrides.enabled_skills.push(presentation.key.clone());
    let enabled_state =
        resolve_skill_state_for_mode(&presentation, "Standard", &overrides, &disabled_project);
    assert!(enabled_state.effective_enabled);
    assert_eq!(
        enabled_state.reason,
        ModeSkillStateReason::EnabledByUserOverride
    );
}

#[test]
fn user_mode_skill_overrides_share_key_normalization_rules() {
    let overrides = openbitfun_agent_runtime::skills::normalize_user_mode_skill_overrides(
        vec![
            " user::openbitfun::pdf ".to_string(),
            String::new(),
            "user::openbitfun::pdf".to_string(),
        ],
        vec![
            "user::openbitfun::pdf".to_string(),
            " user::openbitfun::docx ".to_string(),
            "user::openbitfun::docx".to_string(),
        ],
    );

    assert_eq!(overrides.disabled_skills, vec!["user::openbitfun::pdf"]);
    assert_eq!(overrides.enabled_skills, vec!["user::openbitfun::docx"]);
}

#[test]
fn skill_markdown_and_assistant_output_shape_are_runtime_owned() {
    let markdown = r#"---
name: pdf
description: Work with PDF files.
---

Use the pdf workflow.
"#;
    let mut data = SkillData::from_markdown(
        "/workspace/.openbitfun/skills/pdf".to_string(),
        markdown,
        SkillLocation::Project,
        true,
    )
    .expect("valid skill markdown should parse");
    data.key = "project::openbitfun::pdf".to_string();
    data.source_slot = "openbitfun".to_string();

    assert_eq!(data.name, "pdf");
    assert_eq!(data.description, "Work with PDF files.");
    assert_eq!(data.dir_name, "pdf");
    assert_eq!(data.content, "Use the pdf workflow.\n");

    let assistant = render_loaded_skill_for_assistant(&data, false);
    assert!(assistant.contains("Skill 'pdf' loaded successfully."));
    assert!(assistant.contains("relative to /workspace/.openbitfun/skills/pdf"));
    assert!(assistant.contains("<skill_content>\nUse the pdf workflow.\n\n</skill_content>"));
    assert!(!assistant.contains("from stable key"));

    let stable_assistant = render_loaded_skill_for_assistant(&data, true);
    assert!(stable_assistant.contains("from stable key 'project::openbitfun::pdf'"));
}

#[test]
fn claude_manual_skill_is_not_implicitly_invocable() {
    let markdown = r#"---
name: deploy
description: Deploy the current project.
disable-model-invocation: true
---

Run the deployment workflow.
"#;

    let data = SkillData::from_markdown(
        "/workspace/.claude/skills/deploy".to_string(),
        markdown,
        SkillLocation::Project,
        false,
    )
    .expect("valid Claude skill markdown should parse");

    assert!(!data.allow_implicit_invocation);
}

#[test]
fn claude_user_invocation_metadata_is_independent_from_model_invocation() {
    let markdown = r#"---
name: deploy
description: Deploy the current project.
user-invocable: false
disable-model-invocation: false
argument-hint: "[environment] [version]"
---

Run the deployment workflow.
"#;

    let data = SkillData::from_markdown(
        "/workspace/.claude/skills/deploy".to_string(),
        markdown,
        SkillLocation::Project,
        false,
    )
    .expect("valid Claude skill invocation metadata should parse");

    assert!(!data.allow_user_invocation);
    assert!(data.allow_implicit_invocation);
    assert_eq!(
        data.argument_hint.as_deref(),
        Some("[environment] [version]")
    );
}

#[test]
fn user_invocation_metadata_defaults_to_visible_without_an_argument_hint() {
    let data = SkillData::from_markdown(
        "/workspace/.agents/skills/review".to_string(),
        "---\nname: review\ndescription: Review the current project.\n---\n\nReview it.\n",
        SkillLocation::Project,
        false,
    )
    .expect("skill metadata defaults should parse");

    assert!(data.allow_user_invocation);
    assert_eq!(data.argument_hint, None);
}

#[test]
fn invalid_user_invocation_metadata_is_rejected() {
    for (field, value) in [("user-invocable", "[]"), ("argument-hint", "42")] {
        let markdown = format!(
            "---\nname: review\ndescription: Review the current project.\n{field}: {value}\n---\n\nReview it.\n"
        );
        let error = SkillData::from_markdown(
            "/workspace/.agents/skills/review".to_string(),
            &markdown,
            SkillLocation::Project,
            false,
        )
        .expect_err("invalid invocation metadata should fail closed");

        assert!(error.to_string().contains(field), "field={field}");
    }
}

#[test]
fn user_invocation_filter_keeps_only_picker_entries() {
    let visible = project_skill("review");
    let mut model_only = project_skill("background-check");
    model_only.allow_user_invocation = false;

    let filtered = filter_user_invocable_skills(vec![model_only, visible]);

    assert_eq!(filtered.len(), 1);
    assert_eq!(filtered[0].name, "review");
}

#[test]
fn claude_boolean_aliases_preserve_explicit_only_skill_visibility() {
    for value in ["yes", "ON", "1"] {
        let markdown = format!(
            "---\nname: deploy\ndescription: Deploy the current project.\ndisable-model-invocation: {value}\n---\n\nRun the deployment workflow.\n"
        );
        let data = SkillData::from_markdown(
            "/workspace/.claude/skills/deploy".to_string(),
            &markdown,
            SkillLocation::Project,
            false,
        )
        .expect("Claude-compatible boolean aliases should parse");
        assert!(!data.allow_implicit_invocation, "value={value}");
    }
}

#[test]
fn codex_policy_can_restrict_but_not_relax_skill_invocation() {
    let markdown = r#"---
name: deploy
description: Deploy the current project.
disable-model-invocation: true
---

Run the deployment workflow.
"#;
    let mut data = SkillData::from_markdown(
        "/workspace/.codex/skills/deploy".to_string(),
        markdown,
        SkillLocation::Project,
        false,
    )
    .expect("valid skill markdown should parse");

    data.apply_openai_yaml_policy("policy:\n  allow_implicit_invocation: true\n")
        .expect("valid Codex policy should parse");
    assert!(!data.allow_implicit_invocation);

    let permissive_markdown = r#"---
name: review
description: Review the current project.
---

Run the review workflow.
"#;
    let mut restricted = SkillData::from_markdown(
        "/workspace/.codex/skills/review".to_string(),
        permissive_markdown,
        SkillLocation::Project,
        false,
    )
    .expect("valid skill markdown should parse");
    restricted
        .apply_openai_yaml_policy("policy:\n  allow_implicit_invocation: false\n")
        .expect("valid Codex policy should parse");
    assert!(!restricted.allow_implicit_invocation);
}

#[test]
fn codex_interface_metadata_does_not_affect_skill_identity_or_invocation_policy() {
    let markdown = r#"---
name: deep-research
description: Run a research workflow.
---

Research the topic.
"#;
    let mut data = SkillData::from_markdown(
        "/workspace/.codex/skills/deep-research".to_string(),
        markdown,
        SkillLocation::Project,
        false,
    )
    .expect("valid skill markdown should parse");

    for interface in [
        "interface:\n  display_name: \"Academic Deep Research\"\n",
        "interface:\n  display_name: 123\n",
        "interface: invalid\n",
    ] {
        data.allow_implicit_invocation = true;
        data.apply_openai_yaml_policy(&format!(
            "{interface}policy:\n  allow_implicit_invocation: false\n"
        ))
        .expect("unconsumed interface metadata must not prevent policy parsing");

        assert_eq!(data.name, "deep-research");
        assert!(!data.allow_implicit_invocation);
    }
}

#[test]
fn implicit_skill_filter_keeps_explicit_only_skill_out_of_model_catalog() {
    let visible = project_skill("review");
    let mut explicit_only = project_skill("deploy");
    explicit_only.allow_implicit_invocation = false;

    let filtered = filter_implicitly_invocable_skills(vec![explicit_only, visible]);

    assert_eq!(filtered.len(), 1);
    assert_eq!(filtered[0].name, "review");
}

#[test]
fn skill_candidate_key_group_and_resolution_are_runtime_owned() {
    let markdown = r#"---
name: ppt-design
description: Design presentation slides.
---

Use the presentation workflow.
"#;
    let data = SkillData::from_markdown(
        "/tmp/openbitfun-system/ppt-design".to_string(),
        markdown,
        SkillLocation::User,
        false,
    )
    .expect("valid built-in skill markdown should parse");
    let candidate = SkillCandidate::from_data(
        data,
        "openbitfun-system",
        "openbitfun",
        "OpenBitFun",
        "user",
        10,
        true,
    );

    assert_eq!(candidate.info.key, "user::openbitfun-system::ppt-design");
    assert_eq!(candidate.info.source_slot, "openbitfun-system");
    assert_eq!(candidate.info.group_key.as_deref(), Some("office"));

    let project_presentation = SkillCandidate {
        info: project_skill("ppt-design"),
        priority: 0,
    };
    let visible = resolve_visible_skills(vec![candidate.clone(), project_presentation.clone()]);
    assert_eq!(visible.len(), 1);
    assert_eq!(visible[0].key, "project::openbitfun::ppt-design");

    let annotated = sort_skills(annotate_shadowed_skills(vec![
        candidate,
        project_presentation,
    ]));
    let user_presentation = annotated
        .iter()
        .find(|skill| skill.key == "user::openbitfun-system::ppt-design")
        .expect("user built-in skill should be present");
    assert!(user_presentation.is_shadowed);
    assert_eq!(
        user_presentation.shadowed_by_key.as_deref(),
        Some("project::openbitfun::ppt-design")
    );
}

#[test]
fn shadow_annotations_use_the_same_level_tiebreaker_as_runtime_resolution() {
    let mut user_info = custom_user_skill("pdf");
    user_info.key = "user::home.claude::pdf".to_string();
    user_info.source_slot = "home.claude".to_string();
    user_info.source_id = "claude-code".to_string();
    user_info.source_label = "Claude Code".to_string();
    let user_candidate = SkillCandidate {
        info: user_info,
        priority: 0,
    };
    let project_candidate = SkillCandidate {
        info: project_skill("pdf"),
        priority: 0,
    };

    let runtime_winner =
        resolve_visible_skills(vec![user_candidate.clone(), project_candidate.clone()]);
    assert_eq!(runtime_winner[0].key, project_candidate.info.key);

    let annotated =
        annotate_shadowed_skills(vec![user_candidate.clone(), project_candidate.clone()]);
    let user = annotated
        .iter()
        .find(|skill| skill.key == user_candidate.info.key)
        .expect("user candidate should remain visible");
    let project = annotated
        .iter()
        .find(|skill| skill.key == project_candidate.info.key)
        .expect("project candidate should remain visible");

    assert!(user.is_shadowed);
    assert_eq!(
        user.shadowed_by_key.as_deref(),
        Some(project_candidate.info.key.as_str())
    );
    assert!(!project.is_shadowed);
    assert_eq!(project.shadowed_by_key, None);
}

#[test]
fn mode_skill_candidate_filtering_and_info_are_runtime_owned() {
    let project_doc = SkillCandidate {
        info: project_skill("project-doc"),
        priority: 0,
    };
    let custom_user = SkillCandidate {
        info: custom_user_skill("my-custom-skill"),
        priority: 10,
    };
    let mut disabled_project = HashSet::new();
    disabled_project.insert(project_doc.info.key.clone());

    let filtered = filter_candidates_for_mode(
        vec![project_doc.clone(), custom_user.clone()],
        "Standard",
        &UserModeSkillOverrides::default(),
        &disabled_project,
    );
    assert_eq!(filtered.len(), 1);
    assert_eq!(filtered[0].info.key, custom_user.info.key);

    let all_skills = sort_skills(annotate_shadowed_skills(vec![
        project_doc,
        custom_user.clone(),
    ]));
    let resolved = resolve_visible_skills(filtered);
    let infos = build_mode_skill_infos(
        all_skills,
        resolved,
        "Standard",
        &UserModeSkillOverrides::default(),
        &disabled_project,
        &HashSet::new(),
    );

    let project_doc = infos
        .iter()
        .find(|skill| skill.skill.key == "project::openbitfun::project-doc")
        .expect("project skill should be listed");
    assert!(!project_doc.effective_enabled);
    assert!(!project_doc.selected_for_runtime);
    assert_eq!(
        project_doc.state_reason,
        ModeSkillStateReason::DisabledByProjectOverride
    );

    let custom = infos
        .iter()
        .find(|skill| skill.skill.key == custom_user.info.key)
        .expect("custom user skill should be listed");
    assert!(custom.effective_enabled);
    assert!(custom.selected_for_runtime);
    assert_eq!(
        custom.state_reason,
        ModeSkillStateReason::CustomUserDefaultEnabled
    );
}

#[test]
fn mode_skill_info_reports_the_actual_runtime_winner_after_filtering() {
    let project_pdf = SkillCandidate {
        info: project_skill("pdf"),
        priority: 0,
    };
    let mut codex_pdf_info = custom_user_skill("pdf");
    codex_pdf_info.key = "user::home.codex::pdf".to_string();
    codex_pdf_info.source_slot = "home.codex".to_string();
    codex_pdf_info.source_id = "codex".to_string();
    codex_pdf_info.source_label = "Codex".to_string();
    let codex_pdf = SkillCandidate {
        info: codex_pdf_info,
        priority: 10,
    };
    let mut opencode_pdf_info = custom_user_skill("pdf");
    opencode_pdf_info.key = "user::home.opencode::pdf".to_string();
    opencode_pdf_info.source_slot = "home.opencode".to_string();
    opencode_pdf_info.source_id = "opencode".to_string();
    opencode_pdf_info.source_label = "OpenCode".to_string();
    let opencode_pdf = SkillCandidate {
        info: opencode_pdf_info,
        priority: 11,
    };
    let candidates = vec![project_pdf.clone(), codex_pdf.clone(), opencode_pdf.clone()];
    let mut disabled_project = HashSet::new();
    disabled_project.insert(project_pdf.info.key.clone());

    let filtered = filter_candidates_for_mode(
        candidates.clone(),
        "Standard",
        &UserModeSkillOverrides::default(),
        &disabled_project,
    );
    let resolved = resolve_visible_skills(filtered);
    let infos = build_mode_skill_infos(
        sort_skills(annotate_shadowed_skills(candidates)),
        resolved,
        "Standard",
        &UserModeSkillOverrides::default(),
        &disabled_project,
        &HashSet::new(),
    );

    let project = infos
        .iter()
        .find(|skill| skill.skill.key == project_pdf.info.key)
        .expect("disabled project skill should stay visible");
    assert!(!project.effective_enabled);
    assert!(!project.selected_for_runtime);
    assert!(!project.skill.is_shadowed);
    assert_eq!(project.skill.shadowed_by_key, None);

    let codex = infos
        .iter()
        .find(|skill| skill.skill.key == codex_pdf.info.key)
        .expect("selected Codex skill should stay visible");
    assert!(codex.effective_enabled);
    assert!(codex.selected_for_runtime);
    assert!(!codex.skill.is_shadowed);

    let opencode = infos
        .iter()
        .find(|skill| skill.skill.key == opencode_pdf.info.key)
        .expect("covered OpenCode skill should stay visible");
    assert!(opencode.effective_enabled);
    assert!(!opencode.selected_for_runtime);
    assert!(opencode.skill.is_shadowed);
    assert_eq!(
        opencode.skill.shadowed_by_key.as_deref(),
        Some(codex_pdf.info.key.as_str())
    );
}

#[test]
fn global_skill_disable_overrides_mode_selection_without_changing_mode_defaults() {
    let skill = custom_user_skill("my-custom-skill");
    let candidate = SkillCandidate {
        info: skill.clone(),
        priority: 0,
    };
    let mut globally_disabled = HashSet::new();
    globally_disabled.insert(skill.key.clone());
    assert!(!is_skill_globally_enabled(
        &candidate.info,
        &globally_disabled
    ));

    let infos = build_mode_skill_infos(
        vec![skill],
        Vec::new(),
        "Standard",
        &UserModeSkillOverrides::default(),
        &HashSet::new(),
        &globally_disabled,
    );

    let info = infos.first().expect("skill info should be present");
    assert!(info.default_enabled);
    assert!(!info.globally_enabled);
    assert!(info.effective_enabled);
    assert!(!info.selected_for_runtime);
    assert_eq!(
        info.state_reason,
        ModeSkillStateReason::CustomUserDefaultEnabled
    );

    let filtered = filter_candidates_for_mode(
        vec![candidate],
        "Standard",
        &UserModeSkillOverrides::default(),
        &HashSet::new(),
    );
    assert_eq!(filtered.len(), 1, "mode policy itself remains unchanged");
}

#[test]
fn explicit_invocation_hidden_builtin_fallback_is_runtime_owned() {
    let candidate = SkillCandidate {
        info: builtin_skill("gstack-review"),
        priority: 10,
    };

    match resolve_default_hidden_builtin_for_explicit_invocation(
        "gstack-review",
        vec![candidate.clone()],
        Some("Standard"),
    ) {
        ExplicitSkillInvocationResolution::Found(skill) => {
            assert_eq!(skill.key, "user::openbitfun-system::gstack-review");
        }
        other => panic!("expected hidden gstack fallback, got {other:?}"),
    }

    assert!(matches!(
        resolve_default_hidden_builtin_for_explicit_invocation(
            "missing-skill",
            vec![candidate.clone()],
            Some("Standard")
        ),
        ExplicitSkillInvocationResolution::NotFound
    ));
    assert!(matches!(
        resolve_default_hidden_builtin_for_explicit_invocation(
            "gstack-review",
            vec![candidate],
            None
        ),
        ExplicitSkillInvocationResolution::NotFound
    ));
}

#[test]
fn explicit_invocation_reaches_default_hidden_agent_browser() {
    // Modes that use ControlHub keep agent-browser default-hidden, but an exact
    // explicit invocation must still resolve it.
    let candidate = SkillCandidate {
        info: builtin_skill("agent-browser"),
        priority: 10,
    };

    for mode_id in ["Standard", "Standard", "Claw", "Cowork"] {
        assert_eq!(
            resolve_builtin_default_enabled("agent-browser", mode_id),
            Some(false),
            "agent-browser should be default-off for mode {mode_id}"
        );
        match resolve_default_hidden_builtin_for_explicit_invocation(
            "agent-browser",
            vec![candidate.clone()],
            Some(mode_id),
        ) {
            ExplicitSkillInvocationResolution::Found(skill) => {
                assert_eq!(skill.key, "user::openbitfun-system::agent-browser");
            }
            other => {
                panic!("expected hidden agent-browser fallback for mode {mode_id}, got {other:?}")
            }
        }
    }
}

#[test]
fn skill_scan_reports_tolerate_older_shapes_and_escape_diagnostics() {
    use openbitfun_agent_runtime::skills::{SkillScanDiagnostic, SkillScanReport};
    let legacy = serde_json::json!({"skills": ["pdf"]});
    let report: SkillScanReport<String> = serde_json::from_value(legacy.clone()).unwrap();
    assert!(report.diagnostics.is_empty());
    let roundtrip: SkillScanReport<String> =
        serde_json::from_value(serde_json::to_value(report).unwrap()).unwrap();
    assert_eq!(roundtrip.skills, vec!["pdf"]);
    let diagnostic = SkillScanDiagnostic {
        path: "/remote/<path>".into(),
        source_id: "codex".into(),
        message: "read & parse failed".into(),
    };
    assert!(diagnostic.to_xml().contains("&lt;path&gt;"));
    assert!(diagnostic.to_xml().contains("read &amp; parse failed"));
}
