use crate::native_hooks::{
    build_engine, build_overview, build_overview_with_imports, clear_session_hook_state,
    dispatch_pre_tool_use, hook_settings_paths, ordered_layers, overview, overview_with_facts,
    take_pending_session_context, AgentHooksConfig, NativeHookSessionFacts,
};
use openbitfun_agent_runtime::native_hooks::{
    AgentHookEvent, AgentHookScope, AgentHookSettingsLayer,
};
use serde_json::json;
use std::path::{Path, PathBuf};

fn write_hooks_file(dir: &Path, name: &str, contents: &str) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, contents).expect("hook fixture should be written");
    path
}

#[test]
fn hooks_are_enabled_by_default_but_project_hooks_are_not() {
    let config = AgentHooksConfig::default();
    assert!(config.enabled);
    // Project hook files execute commands declared in the checked-out
    // repository, so they stay opt-in.
    assert!(!config.project_hooks_enabled);
}

#[test]
fn hooks_config_deserializes_from_partial_settings() {
    let config: AgentHooksConfig =
        serde_json::from_value(json!({"project_hooks_enabled": true})).expect("partial config");
    assert!(config.enabled);
    assert!(config.project_hooks_enabled);

    let disabled: AgentHooksConfig =
        serde_json::from_value(json!({"enabled": false})).expect("partial config");
    assert!(!disabled.enabled);
    assert!(!disabled.project_hooks_enabled);

    let empty: AgentHooksConfig = serde_json::from_value(json!({})).expect("empty config");
    assert_eq!(empty, AgentHooksConfig::default());
}

#[test]
fn hooks_config_resolves_at_the_documented_dot_path() {
    // Config dot-paths resolve against the serialized GlobalConfig, so the
    // gates live at `app.hooks` — not `hooks`. A wrong path here would make
    // every lookup fall back to the defaults and silently ignore a user's
    // `enabled: false`.
    let global = crate::service::config::types::GlobalConfig::default();
    let serialized = serde_json::to_value(&global).expect("global config should serialize");

    let mut current = &serialized;
    for key in crate::native_hooks::HOOKS_CONFIG_PATH.split('.') {
        current = current
            .get(key)
            .unwrap_or_else(|| panic!("config path segment '{key}' is missing"));
    }
    assert_eq!(current["enabled"], json!(true));
    assert_eq!(current["project_hooks_enabled"], json!(false));

    let parsed: AgentHooksConfig =
        serde_json::from_value(current.clone()).expect("gates should deserialize at that path");
    assert_eq!(parsed, AgentHooksConfig::default());
}

#[test]
fn user_settings_path_is_always_present_and_project_path_is_gated() {
    let workspace = PathBuf::from("/tmp/example-workspace");

    let without_project = hook_settings_paths(Some(&workspace), false);
    assert_eq!(without_project.len(), 1);
    assert_eq!(without_project[0].0, AgentHookScope::User);
    assert!(without_project[0].1.ends_with("config/hooks.json"));

    let with_project = hook_settings_paths(Some(&workspace), true);
    assert_eq!(with_project.len(), 2);
    assert_eq!(with_project[0].0, AgentHookScope::User);
    assert_eq!(with_project[1].0, AgentHookScope::Project);
    assert_eq!(
        with_project[1].1,
        workspace.join(".openbitfun/config/hooks.json")
    );

    // No workspace means no project layer even when project hooks are enabled.
    let without_workspace = hook_settings_paths(None, true);
    assert_eq!(without_workspace.len(), 1);
    assert_eq!(without_workspace[0].0, AgentHookScope::User);
}

#[test]
fn engine_loads_user_and_project_layers_in_order() {
    let temp = tempfile::tempdir().expect("temp dir");
    let user = write_hooks_file(
        temp.path(),
        "user.json",
        r#"{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"user-hook"}]}]}}"#,
    );
    let project = write_hooks_file(
        temp.path(),
        "project.json",
        r#"{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"project-hook"}]}]}}"#,
    );

    let engine = build_engine(&[
        (AgentHookScope::User, user),
        (AgentHookScope::Project, project),
    ]);

    let rules = engine.settings().rules_for(AgentHookEvent::PreToolUse);
    assert_eq!(rules.len(), 2);
    assert_eq!(rules[0].scope, AgentHookScope::User);
    assert_eq!(rules[0].handlers[0].command, "user-hook");
    assert_eq!(rules[1].scope, AgentHookScope::Project);
    assert_eq!(rules[1].handlers[0].command, "project-hook");
}

#[test]
fn missing_settings_files_produce_an_empty_engine() {
    let temp = tempfile::tempdir().expect("temp dir");
    let engine = build_engine(&[
        (AgentHookScope::User, temp.path().join("absent.json")),
        (
            AgentHookScope::Project,
            temp.path().join("also-absent.json"),
        ),
    ]);

    assert!(engine.is_empty());
    for event in AgentHookEvent::ALL {
        assert!(!engine.has_rules(event));
    }
}

#[test]
fn one_invalid_layer_does_not_disable_the_other() {
    let temp = tempfile::tempdir().expect("temp dir");
    let broken = write_hooks_file(temp.path(), "broken.json", "{ not json");
    let good = write_hooks_file(
        temp.path(),
        "good.json",
        r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"still-runs"}]}]}}"#,
    );

    let engine = build_engine(&[
        (AgentHookScope::User, broken),
        (AgentHookScope::Project, good),
    ]);

    assert!(engine.has_rules(AgentHookEvent::Stop));
    assert_eq!(
        engine.settings().rules_for(AgentHookEvent::Stop)[0].handlers[0].command,
        "still-runs"
    );
}

#[test]
fn oversized_settings_files_are_ignored() {
    let temp = tempfile::tempdir().expect("temp dir");
    let padding = " ".repeat(1024 * 1024 + 1);
    let oversized = write_hooks_file(
        temp.path(),
        "oversized.json",
        &format!(
            r#"{{"description":"{padding}","hooks":{{"Stop":[{{"hooks":[{{"type":"command","command":"too-big"}}]}}]}}}}"#
        ),
    );

    let engine = build_engine(&[(AgentHookScope::User, oversized)]);
    assert!(engine.is_empty());
}

#[tokio::test]
async fn remote_workspaces_skip_hook_dispatch() {
    // Remote workspaces never dispatch: a local hook process cannot act on
    // the remote filesystem. The skip resolves to a no-op decision regardless
    // of local configuration; when hooks are configured it is reported, not
    // silent.
    let decision = dispatch_pre_tool_use(
        NativeHookSessionFacts {
            workspace_id: Some("remote-workspace"),
            session_id: "session-remote",
            turn_id: Some("turn-1"),
            workspace_root: Some(Path::new("/remote/workspace")),
            is_remote_workspace: true,
            model: "model-x",
            bypass_permissions: false,
        },
        "Bash",
        "call-1",
        &json!({"command": "ls"}),
    )
    .await;

    assert!(decision.deny_reason.is_none());
    assert!(!decision.allow);
    assert!(decision.updated_input.is_none());

    // The read-only view carries the same fact, and it never derives a
    // controller-local project path from the remote root.
    let remote = overview_with_facts(
        Some("remote-workspace"),
        Some(Path::new("/remote/workspace")),
        true,
    )
    .await;
    assert!(remote.remote_workspace_unsupported);
    assert!(remote
        .files
        .iter()
        .all(|file| !file.path.starts_with("/remote/workspace")));

    let local = overview(None).await.unwrap();
    assert!(!local.remote_workspace_unsupported);
}

#[test]
fn overview_reports_the_layers_a_dispatch_would_load() {
    let temp = tempfile::tempdir().expect("temp dir");
    let user = write_hooks_file(
        temp.path(),
        "user.json",
        r#"{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"user-hook","timeout":5}]}]}}"#,
    );
    let project = write_hooks_file(
        temp.path(),
        "project.json",
        r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"project-hook"}]}]}}"#,
    );
    let candidates = vec![
        (AgentHookScope::User, user),
        (AgentHookScope::Project, project),
    ];

    let gated = build_overview(AgentHooksConfig::default(), candidates.clone());
    assert!(gated.enabled);
    assert!(!gated.project_hooks_enabled);
    // The project file is listed so it stays discoverable, but its rules are
    // not loaded while the gate is off.
    assert_eq!(gated.files.len(), 2);
    assert!(gated.files[0].loaded && gated.files[0].exists);
    assert!(!gated.files[1].loaded && gated.files[1].exists);
    assert_eq!(gated.rules.len(), 1);
    assert_eq!(gated.rules[0].event, "PreToolUse");
    assert_eq!(gated.rules[0].matcher, "Bash");
    assert!(gated.rules[0].matcher_is_valid);
    assert_eq!(gated.rules[0].scope, "user");
    assert_eq!(gated.rules[0].handlers[0].command, "user-hook");
    assert_eq!(gated.rules[0].handlers[0].timeout_seconds, 5);
    assert_eq!(gated.total_handlers, 1);

    let with_project = build_overview(
        AgentHooksConfig {
            enabled: true,
            project_hooks_enabled: true,
        },
        candidates.clone(),
    );
    assert!(with_project.files.iter().all(|file| file.loaded));
    assert_eq!(with_project.total_handlers, 2);
    assert!(with_project
        .rules
        .iter()
        .any(|rule| rule.event == "Stop" && rule.scope == "project"));

    // A disabled master switch loads nothing, but still names both files so
    // the reader can see what would run once it is turned back on.
    let disabled = build_overview(
        AgentHooksConfig {
            enabled: false,
            project_hooks_enabled: true,
        },
        candidates,
    );
    assert!(disabled.files.iter().all(|file| !file.loaded));
    assert!(disabled.rules.is_empty());
    assert_eq!(disabled.total_handlers, 0);
}

#[test]
fn overview_surfaces_configuration_issues_and_a_never_matching_matcher() {
    let temp = tempfile::tempdir().expect("temp dir");
    let user = write_hooks_file(
        temp.path(),
        "user.json",
        r#"{"hooks":{"PreToolUse":[{"matcher":"Bash(","hooks":[{"type":"command","command":"never-runs"}]}],"NotAnEvent":[]}}"#,
    );

    let overview = build_overview(
        AgentHooksConfig::default(),
        vec![(AgentHookScope::User, user)],
    );

    assert_eq!(overview.rules.len(), 1);
    assert!(!overview.rules[0].matcher_is_valid);
    assert!(overview
        .issues
        .iter()
        .any(|issue| issue.contains("NotAnEvent")));
    assert!(overview
        .issues
        .iter()
        .any(|issue| issue.contains("not a valid pattern")));
}

#[test]
fn overview_reports_an_oversized_file_that_dispatch_would_skip() {
    let temp = tempfile::tempdir().expect("temp dir");
    let padding = " ".repeat(1024 * 1024 + 1);
    let oversized = write_hooks_file(
        temp.path(),
        "oversized.json",
        &format!(
            r#"{{"description":"{padding}","hooks":{{"Stop":[{{"hooks":[{{"type":"command","command":"too-big"}}]}}]}}}}"#
        ),
    );

    let overview = build_overview(
        AgentHooksConfig::default(),
        vec![(AgentHookScope::User, oversized)],
    );

    assert!(overview.rules.is_empty());
    // Silence here would read as "nothing is configured" instead of "your
    // file was skipped".
    assert!(overview
        .issues
        .iter()
        .any(|issue| issue.contains("byte limit")));
}

#[test]
fn session_context_buffer_starts_empty_and_clears() {
    assert!(take_pending_session_context("unknown-session").is_empty());
    // Clearing an unknown session is a no-op, not an error.
    clear_session_hook_state("unknown-session");
    assert!(take_pending_session_context("unknown-session").is_empty());
}

#[test]
fn imported_layers_share_the_existing_engine_in_the_documented_scope_order() {
    let layer = |scope, source: &str| AgentHookSettingsLayer {
        scope,
        source: source.to_string(),
        bytes: br#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"check"}]}]}}"#.to_vec(),
    };
    let ordered = ordered_layers(
        vec![
            layer(AgentHookScope::User, "manual-user"),
            layer(AgentHookScope::Project, "manual-project"),
        ],
        vec![
            layer(AgentHookScope::User, "imported-user"),
            layer(AgentHookScope::Project, "imported-project"),
        ],
    );

    assert_eq!(
        ordered
            .iter()
            .map(|layer| layer.source.as_str())
            .collect::<Vec<_>>(),
        vec![
            "manual-user",
            "imported-user",
            "manual-project",
            "imported-project"
        ]
    );
}

#[test]
fn imported_project_layers_do_not_depend_on_the_manual_project_file_gate() {
    let imported = AgentHookSettingsLayer {
        scope: AgentHookScope::Project,
        source: "managed-project-import".to_string(),
        bytes: br#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"check"}]}]}}"#.to_vec(),
    };
    let overview = build_overview_with_imports(
        AgentHooksConfig {
            enabled: true,
            project_hooks_enabled: false,
        },
        Vec::new(),
        vec![imported],
    );

    assert_eq!(overview.total_handlers, 1);
    assert_eq!(overview.files.len(), 1);
    assert!(overview.files[0].loaded);
}
