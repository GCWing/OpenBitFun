use openbitfun_agent_runtime::custom_agent::{
    custom_agent_possible_dirs, custom_agent_read_markdown_file, custom_agent_read_markdown_str,
    custom_agent_review_writable_tools, custom_agent_save_markdown_file,
    default_custom_agent_tools, default_custom_agent_user_context_policy,
    load_custom_agent_definitions, validate_custom_agent_definition, CustomAgentDefinition,
    CustomAgentDefinitionError, CustomAgentDiscoveryRoots, CustomAgentKind, CustomAgentLevel,
    CustomAgentModelFallback, CustomAgentValidationContext, ParsedCustomAgentDefinition,
    DEFAULT_CUSTOM_MODE_MODEL, DEFAULT_CUSTOM_MODE_READONLY,
};
use openbitfun_agent_runtime::prompt::UserContextPolicy;
use std::fs;
use std::path::{Path, PathBuf};

struct BuildModeDefinitionInput<'a>(
    Option<&'a str>,
    Option<&'a str>,
    Option<&'a str>,
    Option<Vec<String>>,
    Option<bool>,
    Option<&'a str>,
    Option<UserContextPolicy>,
    CustomAgentLevel,
);

fn build_mode_definition(
    input: BuildModeDefinitionInput<'_>,
) -> Result<ParsedCustomAgentDefinition, CustomAgentDefinitionError> {
    let BuildModeDefinitionInput(
        id,
        name,
        description,
        tools,
        readonly,
        model,
        user_context_policy,
        level,
    ) = input;
    CustomAgentDefinition::from_front_matter_fields(
        id,
        name,
        description,
        Some(CustomAgentKind::Mode),
        tools,
        readonly,
        None,
        model,
        user_context_policy,
        "Act as a focused project specialist.".to_string(),
        level,
    )
}

#[test]
fn custom_mode_defaults_generate_id_and_default_policy() {
    let parsed = build_mode_definition(BuildModeDefinitionInput(
        None,
        Some("PlannerPlus"),
        Some("Custom planning mode"),
        None,
        None,
        None,
        None,
        CustomAgentLevel::User,
    ))
    .expect("mode definition should be valid");

    assert_eq!(parsed.definition.id, "PlannerPlus");
    assert_eq!(parsed.definition.kind, CustomAgentKind::Mode);
    assert_eq!(
        parsed.definition.tools,
        default_custom_agent_tools(CustomAgentKind::Mode)
    );
    assert!(parsed.definition.tools.contains(&"ListModels".to_string()));
    for tool_name in ["get_goal", "create_goal", "update_goal"] {
        assert!(parsed.definition.tools.iter().any(|tool| tool == tool_name));
    }
    for tool_name in [
        "AgentSpawn",
        "AgentSendInput",
        "AgentControl",
        "AgentList",
        "AgentWait",
    ] {
        assert!(parsed.definition.tools.iter().any(|tool| tool == tool_name));
    }
    assert!(!parsed.definition.tools.iter().any(|tool| tool == "Task"));
    assert_eq!(parsed.definition.readonly, DEFAULT_CUSTOM_MODE_READONLY);
    assert_eq!(parsed.definition.model, DEFAULT_CUSTOM_MODE_MODEL);
    assert_eq!(
        parsed.definition.user_context_policy,
        default_custom_agent_user_context_policy(CustomAgentKind::Mode)
    );
    assert!(parsed.metadata.generated_id_from_name);
    assert!(parsed.metadata.used_default_tools);
}

#[test]
fn custom_mode_rejects_review_flag() {
    let error = CustomAgentDefinition::from_front_matter_fields(
        Some("PlannerPlus"),
        Some("PlannerPlus"),
        Some("Custom planning mode"),
        Some(CustomAgentKind::Mode),
        None,
        None,
        Some(true),
        None,
        None,
        "Act as a focused project specialist.".to_string(),
        CustomAgentLevel::User,
    )
    .expect_err("mode definitions must reject review=true");

    assert_eq!(
        error,
        CustomAgentDefinitionError::ReviewModeRequiresSubagent
    );
    assert_eq!(
        error.message(),
        "review: true is only supported for subagents"
    );
}

#[test]
fn custom_mode_markdown_save_omits_default_fields() {
    let dir = TestTempDir::new("openbitfun-runtime-custom-mode-defaults");
    let path = dir.join("planner.md");
    let definition = build_mode_definition(BuildModeDefinitionInput(
        Some("PlannerPlus"),
        Some("PlannerPlus"),
        Some("Custom planning mode"),
        None,
        None,
        None,
        None,
        CustomAgentLevel::User,
    ))
    .expect("mode definition should be valid")
    .definition;

    custom_agent_save_markdown_file(&path, &definition).expect("mode markdown should save");

    let saved = fs::read_to_string(&path).expect("saved mode should be readable");
    assert!(saved.contains("schema_version: 1"));
    assert!(saved.contains("kind: mode"));
    assert!(saved.contains("id: PlannerPlus"));
    assert!(!saved.contains("tools:"));
    assert!(!saved.contains("readonly:"));
    assert!(!saved.contains("model:"));
    assert!(!saved.contains("user_context_policy:"));

    let loaded = custom_agent_read_markdown_file(&path, CustomAgentLevel::User)
        .expect("saved mode should load");
    assert_eq!(loaded.definition, definition);
    assert_eq!(loaded.metadata.schema_version, Some(1));
}

#[test]
fn custom_mode_markdown_save_round_trips_custom_policy_and_model() {
    let dir = TestTempDir::new("openbitfun-runtime-custom-mode-custom");
    let path = dir.join("planner.md");
    let policy = UserContextPolicy::empty().with_workspace_instructions();
    let definition = build_mode_definition(BuildModeDefinitionInput(
        Some("PlannerPlus"),
        Some("PlannerPlus"),
        Some("Custom planning mode"),
        Some(vec!["Read".to_string(), "Grep".to_string()]),
        Some(true),
        Some("fast"),
        Some(policy.clone()),
        CustomAgentLevel::User,
    ))
    .expect("mode definition should be valid")
    .definition;

    custom_agent_save_markdown_file(&path, &definition).expect("mode markdown should save");

    let saved = fs::read_to_string(&path).expect("saved mode should be readable");
    assert!(saved.contains("readonly: true"));
    assert!(saved.contains("model: fast"));
    assert!(saved.contains("user_context_policy:"));
    assert!(saved.contains("- workspace_instructions"));
    assert!(saved.contains("- Read"));
    assert!(saved.contains("- Grep"));

    let loaded = custom_agent_read_markdown_file(&path, CustomAgentLevel::User)
        .expect("saved mode should load");
    assert_eq!(loaded.definition, definition);
    assert_eq!(loaded.definition.user_context_policy, policy);
}

#[test]
fn custom_mode_markdown_save_round_trips_empty_custom_policy() {
    let dir = TestTempDir::new("openbitfun-runtime-custom-mode-empty-policy");
    let path = dir.join("planner.md");
    let policy = UserContextPolicy::empty();
    let definition = build_mode_definition(BuildModeDefinitionInput(
        Some("PlannerPlus"),
        Some("PlannerPlus"),
        Some("Custom planning mode"),
        None,
        None,
        None,
        Some(policy.clone()),
        CustomAgentLevel::User,
    ))
    .expect("mode definition should be valid")
    .definition;

    custom_agent_save_markdown_file(&path, &definition).expect("mode markdown should save");

    let saved = fs::read_to_string(&path).expect("saved mode should be readable");
    assert!(saved.contains("user_context_policy: []"));

    let loaded = custom_agent_read_markdown_file(&path, CustomAgentLevel::User)
        .expect("saved mode should load");
    assert_eq!(loaded.definition, definition);
    assert_eq!(loaded.definition.user_context_policy, policy);
}

#[test]
fn custom_mode_invalid_user_context_policy_matches_contract_error() {
    let error = custom_agent_read_markdown_str(
        r#"---
schema_version: 1
kind: mode
id: PlannerPlus
name: PlannerPlus
description: Custom planning mode
user_context_policy:
  - unsupported_section
---

Act as a focused project specialist.
"#,
        CustomAgentLevel::User,
    )
    .expect_err("invalid user context policy should fail");

    assert_eq!(error, "Invalid user_context_policy field");
}

#[test]
fn custom_mode_discovery_rejects_project_scoped_modes_without_dropping_valid_agents() {
    let workspace = TestTempDir::new("openbitfun-runtime-custom-mode-workspace");
    let user_root = TestTempDir::new("openbitfun-runtime-custom-mode-user");
    let project_agents_dir = workspace.path.join(".openbitfun").join("agents");
    let user_agents_dir = user_root.path.join("agents");
    fs::create_dir_all(&project_agents_dir).expect("project agents dir should be created");
    fs::create_dir_all(&user_agents_dir).expect("user agents dir should be created");

    write_mode(
        &project_agents_dir.join("project-mode.md"),
        "ProjectPlanner",
        CustomAgentLevel::Project,
    );
    write_mode(
        &user_agents_dir.join("user-mode.md"),
        "UserPlanner",
        CustomAgentLevel::User,
    );
    write_subagent(
        &project_agents_dir.join("project-helper.md"),
        "ProjectHelper",
        CustomAgentLevel::Project,
    );

    let report = load_custom_agent_definitions(&CustomAgentDiscoveryRoots {
        workspace_root: Some(workspace.path.clone()),
        openbitfun_user_agents_dir: Some(user_agents_dir),
        home_dir: None,
    });

    assert_eq!(
        report
            .definitions
            .iter()
            .map(|loaded| loaded.definition.id.as_str())
            .collect::<Vec<_>>(),
        vec!["ProjectHelper", "UserPlanner"]
    );
    assert_eq!(report.errors.len(), 1);
    assert_eq!(
        report.errors[0].error,
        "Project-scoped custom modes are not supported"
    );
    assert_eq!(
        report.errors[0].path,
        project_agents_dir.join("project-mode.md")
    );
}

#[test]
fn custom_agent_validation_filters_invalid_tools_and_falls_back_model() {
    let mut definition = build_mode_definition(BuildModeDefinitionInput(
        Some("PlannerPlus"),
        Some("PlannerPlus"),
        Some("Custom planning mode"),
        Some(vec![
            "Read".to_string(),
            "MissingTool".to_string(),
            "Grep".to_string(),
        ]),
        None,
        Some("missing-model"),
        None,
        CustomAgentLevel::User,
    ))
    .expect("mode definition should be valid")
    .definition;

    let report = validate_custom_agent_definition(
        &mut definition,
        &Default::default(),
        CustomAgentValidationContext {
            valid_tools: &["Read".to_string(), "Grep".to_string()],
            readonly_tools: &["Read".to_string()],
            valid_models: &["primary".to_string()],
        },
    );

    assert_eq!(definition.tools, ["Read", "Grep"]);
    assert_eq!(definition.model, DEFAULT_CUSTOM_MODE_MODEL);
    assert_eq!(report.invalid_tools, ["MissingTool"]);
    assert_eq!(
        report.model_fallback,
        Some(CustomAgentModelFallback {
            original: "missing-model".to_string(),
            fallback: DEFAULT_CUSTOM_MODE_MODEL.to_string(),
        })
    );
    assert!(!report.default_mode_tools_used);
    assert!(report.writable_review_tools.is_empty());
}

#[test]
fn custom_agent_validation_forces_review_subagents_to_readonly_tools() {
    let mut definition = CustomAgentDefinition::from_front_matter_fields(
        Some("ReviewExtra"),
        Some("ReviewExtra"),
        Some("Review changed files"),
        Some(CustomAgentKind::Subagent),
        Some(vec![
            "Read".to_string(),
            "Write".to_string(),
            "UnknownTool".to_string(),
        ]),
        Some(false),
        Some(true),
        Some("fast"),
        None,
        "Review the selected files.".to_string(),
        CustomAgentLevel::User,
    )
    .expect("subagent definition should be valid")
    .definition;

    let report = validate_custom_agent_definition(
        &mut definition,
        &Default::default(),
        CustomAgentValidationContext {
            valid_tools: &["Read".to_string(), "Write".to_string()],
            readonly_tools: &["Read".to_string()],
            valid_models: &["fast".to_string()],
        },
    );

    assert!(definition.readonly);
    assert_eq!(definition.tools, ["Read"]);
    assert_eq!(report.invalid_tools, ["UnknownTool"]);
    assert_eq!(report.writable_review_tools, ["Write"]);
    assert_eq!(
        custom_agent_review_writable_tools(
            &["Read".to_string(), "Write".to_string()],
            &["Read".to_string()],
        ),
        ["Write"]
    );
}

#[test]
fn custom_agent_discovery_ignores_non_openbitfun_agent_dirs() {
    let workspace = TestTempDir::new("openbitfun-runtime-custom-agent-workspace");
    let user_root = TestTempDir::new("openbitfun-runtime-custom-agent-user");
    let home = TestTempDir::new("openbitfun-runtime-custom-agent-home");
    let project_openbitfun = workspace.path.join(".openbitfun").join("agents");
    let project_claude = workspace.path.join(".claude").join("agents");
    let user_agents = user_root.path.join("agents");
    let home_claude = home.path.join(".claude").join("agents");
    fs::create_dir_all(&project_openbitfun)
        .expect("project openbitfun agents dir should be created");
    fs::create_dir_all(&project_claude).expect("project claude agents dir should be created");
    fs::create_dir_all(&user_agents).expect("user agents dir should be created");
    fs::create_dir_all(&home_claude).expect("home claude agents dir should be created");

    write_subagent(
        &project_openbitfun.join("project-openbitfun.md"),
        "OpenBitFunProject",
        CustomAgentLevel::Project,
    );
    write_subagent(
        &project_claude.join("project-claude.md"),
        "ClaudeProject",
        CustomAgentLevel::Project,
    );
    write_subagent(
        &user_agents.join("user-openbitfun.md"),
        "OpenBitFunUser",
        CustomAgentLevel::User,
    );
    write_subagent(
        &home_claude.join("home-claude.md"),
        "ClaudeHome",
        CustomAgentLevel::User,
    );

    let roots = CustomAgentDiscoveryRoots {
        workspace_root: Some(workspace.path.clone()),
        openbitfun_user_agents_dir: Some(user_agents.clone()),
        home_dir: Some(home.path.clone()),
    };

    assert_eq!(
        custom_agent_possible_dirs(&roots)
            .iter()
            .map(|entry| entry.path.as_path())
            .collect::<Vec<_>>(),
        vec![project_openbitfun.as_path(), user_agents.as_path()]
    );

    let report = load_custom_agent_definitions(&roots);

    assert_eq!(
        report
            .definitions
            .iter()
            .map(|loaded| loaded.definition.id.as_str())
            .collect::<Vec<_>>(),
        vec!["OpenBitFunProject", "OpenBitFunUser"]
    );
    assert!(report.errors.is_empty());
}

struct TestTempDir {
    path: PathBuf,
}

impl TestTempDir {
    fn new(prefix: &str) -> Self {
        let path = std::env::temp_dir().join(format!("{prefix}-{}", unique_suffix()));
        fs::create_dir_all(&path).expect("temp dir should be created");
        Self { path }
    }

    fn join(&self, name: &str) -> PathBuf {
        self.path.join(name)
    }
}

impl Drop for TestTempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn write_mode(path: &Path, id: &str, level: CustomAgentLevel) {
    let definition = build_mode_definition(BuildModeDefinitionInput(
        Some(id),
        Some(id),
        Some("Custom planning mode"),
        None,
        None,
        None,
        None,
        level,
    ))
    .expect("mode definition should be valid")
    .definition;
    custom_agent_save_markdown_file(path, &definition).expect("mode markdown should save");
}

fn write_subagent(path: &Path, id: &str, level: CustomAgentLevel) {
    let definition = CustomAgentDefinition::from_front_matter_fields(
        Some(id),
        Some(id),
        Some("Custom helper subagent"),
        Some(CustomAgentKind::Subagent),
        None,
        None,
        None,
        None,
        None,
        "Investigate the relevant files.".to_string(),
        level,
    )
    .expect("subagent definition should be valid")
    .definition;
    custom_agent_save_markdown_file(path, &definition).expect("subagent markdown should save");
}

fn unique_suffix() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time should be after UNIX epoch")
        .as_nanos()
        .to_string()
}
