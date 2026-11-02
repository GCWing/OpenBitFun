#![cfg(feature = "workspace-instructions")]

use openbitfun_services_core::workspace_instructions::{
    read_workspace_conditional_instruction_sources, read_workspace_instruction_files,
    read_workspace_instruction_source_catalog, read_workspace_instruction_sources,
    WorkspaceInstructionPathMatcher,
};
use std::fs;

fn instruction_names(
    files: &[openbitfun_services_core::workspace_instructions::WorkspaceInstructionFile],
) -> Vec<&str> {
    files.iter().map(|file| file.name.as_str()).collect()
}

#[tokio::test]
async fn workspace_instruction_families_select_agents_then_claude_then_opencode() {
    let temp = tempfile::tempdir().expect("tempdir");
    fs::create_dir_all(temp.path().join(".claude")).expect("claude directory");
    fs::write(temp.path().join("AGENTS.md"), "agent rules\n").expect("agents");
    fs::write(temp.path().join("CLAUDE.md"), "claude rules\n").expect("claude");
    fs::write(temp.path().join(".claude/CLAUDE.md"), "claude fallback\n").expect("fallback");
    fs::write(
        temp.path().join("opencode.json"),
        r#"{"instructions":["guide.md"]}"#,
    )
    .expect("OpenCode config");
    fs::write(temp.path().join("guide.md"), "OpenCode rules\n").expect("OpenCode rules");

    let files = read_workspace_instruction_files(temp.path())
        .await
        .expect("instruction files");

    assert_eq!(files.len(), 1);
    assert_eq!(files[0].name, "AGENTS.md");
    assert_eq!(files[0].content, "agent rules\n");

    fs::write(temp.path().join("AGENTS.md"), " \n\t").expect("blank agents");
    let files = read_workspace_instruction_files(temp.path())
        .await
        .expect("instruction files");
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].name, "CLAUDE.md");

    fs::write(temp.path().join("CLAUDE.md"), "").expect("empty claude");
    let files = read_workspace_instruction_files(temp.path()).await.unwrap();
    assert_eq!(instruction_names(&files), [".claude/CLAUDE.md"]);

    fs::write(temp.path().join(".claude/CLAUDE.md"), " \n\t").expect("blank fallback");
    let files = read_workspace_instruction_files(temp.path()).await.unwrap();
    assert_eq!(instruction_names(&files), ["guide.md"]);
    assert_eq!(files[0].content, "OpenCode rules\n");
}

#[tokio::test]
async fn workspace_instruction_override_skips_empty_files_and_suppresses_claude() {
    let temp = tempfile::tempdir().expect("tempdir");
    fs::write(temp.path().join("AGENTS.override.md"), "override rules\n").expect("override");
    fs::write(temp.path().join("AGENTS.md"), "base rules\n").expect("agents");
    fs::write(temp.path().join("CLAUDE.md"), "claude rules\n").expect("claude");

    let files = read_workspace_instruction_files(temp.path())
        .await
        .expect("instruction files");

    assert_eq!(files.len(), 1);
    assert_eq!(files[0].name, "AGENTS.override.md");
    assert_eq!(files[0].content, "override rules\n");

    for empty in ["", " \n\t"] {
        fs::write(temp.path().join("AGENTS.override.md"), empty).expect("blank override");
        let files = read_workspace_instruction_files(temp.path())
            .await
            .expect("instruction files");
        assert_eq!(instruction_names(&files), ["AGENTS.md"]);
        assert_eq!(files[0].content, "base rules\n");
    }
}

#[tokio::test]
async fn claude_project_files_and_unconditional_rules_have_deterministic_order() {
    let temp = tempfile::tempdir().expect("tempdir");
    fs::create_dir_all(temp.path().join(".claude/rules/nested")).expect("rules dir");
    fs::write(temp.path().join("AGENTS.md"), " \n\t").expect("blank agents");
    fs::write(temp.path().join("CLAUDE.md"), "root claude\n").expect("root claude");
    fs::write(temp.path().join(".claude/CLAUDE.md"), "fallback claude\n").expect("fallback claude");
    fs::write(temp.path().join("CLAUDE.local.md"), "local claude\n").expect("local claude");
    fs::write(temp.path().join(".claude/rules/z-last.md"), "last rule\n").expect("last rule");
    fs::write(
        temp.path().join(".claude/rules/nested/a-first.md"),
        "first rule\n",
    )
    .expect("first rule");
    fs::write(
        temp.path().join(".claude/rules/path-scoped.md"),
        "---\npaths:\n  - src/**/*.rs\n---\nconditional rule\n",
    )
    .expect("path scoped rule");

    let files = read_workspace_instruction_files(temp.path())
        .await
        .expect("instructions");

    assert_eq!(
        instruction_names(&files),
        vec![
            "CLAUDE.md",
            "CLAUDE.local.md",
            ".claude/rules/nested/a-first.md",
            ".claude/rules/z-last.md",
        ]
    );
    assert_eq!(files[0].content, "root claude\n");
    assert!(!files.iter().any(|file| file.name == ".claude/CLAUDE.md"));
    assert!(!files.iter().any(|file| file.name.contains("path-scoped")));
}

#[tokio::test]
async fn claude_project_sources_preserve_path_scoped_rules_for_late_activation() {
    let temp = tempfile::tempdir().expect("tempdir");
    fs::create_dir_all(temp.path().join(".claude/rules")).expect("rules dir");
    fs::write(
        temp.path().join(".claude/rules/rust.md"),
        "---\npaths:\n  - src/**/*.rs\n  - tests/**/*.rs\n---\n\nUse the shared error type.\n",
    )
    .expect("path scoped rule");

    let files = read_workspace_instruction_sources(temp.path())
        .await
        .expect("instruction sources");

    assert_eq!(files.len(), 1);
    assert_eq!(files[0].name, ".claude/rules/rust.md");
    assert_eq!(files[0].path_patterns, vec!["src/**/*.rs", "tests/**/*.rs"]);
    assert_eq!(files[0].content, "Use the shared error type.\n");
}

#[tokio::test]
async fn bom_prefixed_path_scoped_rule_is_never_loaded_at_startup() {
    let temp = tempfile::tempdir().expect("tempdir");
    fs::create_dir_all(temp.path().join(".claude/rules")).expect("rules dir");
    fs::write(
        temp.path().join(".claude/rules/windows.md"),
        "\u{feff}---\r\npaths:\r\n  - src/**/*.rs\r\n---\r\n\r\nWindows rule\r\n",
    )
    .expect("path scoped rule");

    let startup = read_workspace_instruction_files(temp.path())
        .await
        .expect("startup instructions");
    let conditional = read_workspace_conditional_instruction_sources(temp.path())
        .await
        .expect("conditional instructions");

    assert!(startup.is_empty());
    assert_eq!(
        instruction_names(&conditional),
        vec![".claude/rules/windows.md"]
    );
    assert_eq!(conditional[0].path_patterns, vec!["src/**/*.rs"]);
    assert_eq!(conditional[0].content, "Windows rule\r\n");
}

#[tokio::test]
async fn path_scoped_project_rule_imports_inherit_the_parent_scope() {
    let temp = tempfile::tempdir().expect("tempdir");
    fs::create_dir_all(temp.path().join(".claude/shared")).expect("shared dir");
    fs::create_dir_all(temp.path().join(".claude/rules")).expect("rules dir");
    fs::write(
        temp.path().join(".claude/rules/rust.md"),
        "---\npaths:\n  - src/**/*.rs\n---\nRust rule\n@../shared/base.md\n",
    )
    .expect("path scoped rule");
    fs::write(
        temp.path().join(".claude/shared/base.md"),
        "Imported base\n@nested.md\n",
    )
    .expect("base import");
    fs::write(
        temp.path().join(".claude/shared/nested.md"),
        "Nested import\n",
    )
    .expect("nested import");

    let files = read_workspace_instruction_sources(temp.path())
        .await
        .expect("instruction sources");
    let rule = files
        .iter()
        .find(|file| file.name == ".claude/rules/rust.md")
        .expect("scoped rule");

    assert_eq!(rule.path_patterns, vec!["src/**/*.rs"]);
    assert!(rule.content.contains("Rust rule"));
    assert!(rule.content.contains("Imported base"));
    assert!(rule.content.contains("Nested import"));
}

#[tokio::test]
async fn agents_family_suppresses_claude_rules_and_skips_invalid_lower_sources() {
    let temp = tempfile::tempdir().expect("tempdir");
    fs::create_dir_all(temp.path().join(".claude/rules")).expect("rules dir");
    fs::write(temp.path().join("AGENTS.md"), "startup instructions\n").expect("agents");
    fs::write(
        temp.path().join("opencode.json"),
        "{ invalid OpenCode config",
    )
    .expect("OpenCode config");
    fs::write(
        temp.path().join(".claude/rules/general.md"),
        "General rule\n",
    )
    .expect("general rule");
    fs::write(
        temp.path().join(".claude/rules/rust.md"),
        "---\npaths:\n  - src/**/*.rs\n---\nRust rule\n",
    )
    .expect("scoped rule");

    let sources = read_workspace_instruction_sources(temp.path())
        .await
        .expect("selected AGENTS sources");
    assert_eq!(instruction_names(&sources), ["AGENTS.md"]);
    let catalog = read_workspace_instruction_source_catalog(temp.path())
        .await
        .expect("selected source catalog");
    assert!(catalog.incomplete_ecosystems.is_empty());
    assert_eq!(catalog.sources.len(), 1);
    assert_eq!(catalog.sources[0].ecosystem_id, "shared");

    let files = read_workspace_conditional_instruction_sources(temp.path())
        .await
        .expect("conditional sources");

    assert!(files.is_empty());

    fs::write(temp.path().join("AGENTS.md"), "").expect("empty agents");
    let files = read_workspace_conditional_instruction_sources(temp.path())
        .await
        .expect("Claude conditional sources");
    assert_eq!(instruction_names(&files), [".claude/rules/rust.md"]);
}

#[tokio::test]
async fn claude_local_and_rules_only_families_suppress_opencode() {
    let temp = tempfile::tempdir().expect("tempdir");
    fs::create_dir_all(temp.path().join(".claude/rules")).unwrap();
    fs::write(
        temp.path().join("opencode.json"),
        r#"{"instructions":["guide.md"]}"#,
    )
    .unwrap();
    fs::write(temp.path().join("guide.md"), "OpenCode rules\n").unwrap();
    fs::write(temp.path().join("CLAUDE.local.md"), "Claude local\n").unwrap();

    let files = read_workspace_instruction_files(temp.path()).await.unwrap();
    assert_eq!(instruction_names(&files), ["CLAUDE.local.md"]);

    fs::write(temp.path().join("CLAUDE.local.md"), " \n\t").unwrap();
    fs::write(
        temp.path().join(".claude/rules/general.md"),
        "Claude general\n",
    )
    .unwrap();
    let files = read_workspace_instruction_files(temp.path()).await.unwrap();
    assert_eq!(instruction_names(&files), [".claude/rules/general.md"]);

    fs::write(temp.path().join(".claude/rules/general.md"), "").unwrap();
    fs::write(
        temp.path().join(".claude/rules/rust.md"),
        "---\npaths: [\"src/**/*.rs\"]\n---\nClaude Rust\n",
    )
    .unwrap();
    assert!(read_workspace_instruction_files(temp.path())
        .await
        .unwrap()
        .is_empty());
    let conditional = read_workspace_conditional_instruction_sources(temp.path())
        .await
        .unwrap();
    assert_eq!(instruction_names(&conditional), [".claude/rules/rust.md"]);
    let catalog = read_workspace_instruction_source_catalog(temp.path())
        .await
        .unwrap();
    assert_eq!(catalog.sources.len(), 1);
    assert_eq!(catalog.sources[0].ecosystem_id, "claude-code");

    fs::write(temp.path().join(".claude/rules/rust.md"), " \n\t").unwrap();
    let files = read_workspace_instruction_files(temp.path()).await.unwrap();
    assert_eq!(instruction_names(&files), ["guide.md"]);
}

#[test]
fn claude_path_scope_globs_preserve_literal_bracket_escapes() {
    let matcher = WorkspaceInstructionPathMatcher::compile(
        &[r"photos \[2024/**".to_string()],
        ".claude/rules/photos.md",
    )
    .expect("escaped pattern must compile");

    assert!(matcher.is_match("photos [2024/a.png"));
    assert!(!matcher.is_match("photos a/a.png"));
}

#[tokio::test]
async fn claude_internal_imports_are_depth_first_deduplicated_and_workspace_contained() {
    let temp = tempfile::tempdir().expect("tempdir");
    let outside = tempfile::tempdir().expect("outside tempdir");
    fs::create_dir_all(temp.path().join("docs")).expect("docs dir");
    fs::write(outside.path().join("outside.md"), "must not load\n").expect("outside");
    fs::write(
        temp.path().join("CLAUDE.md"),
        "Project rules.\n@docs/base.md\n@../outside.md\n@~/private.md\n",
    )
    .expect("claude");
    fs::write(
        temp.path().join("docs/base.md"),
        "Base rules.\n@nested.md\n@nested.md\n",
    )
    .expect("base");
    fs::write(
        temp.path().join("docs/nested.md"),
        "Nested rules.\n@../CLAUDE.md\n",
    )
    .expect("nested");

    let files = read_workspace_instruction_files(temp.path())
        .await
        .expect("instructions");

    assert_eq!(
        instruction_names(&files),
        vec!["CLAUDE.md", "docs/base.md", "docs/nested.md"]
    );
    assert_eq!(
        files
            .iter()
            .filter(|file| file.name == "docs/nested.md")
            .count(),
        1
    );
}

#[tokio::test]
async fn opencode_project_instructions_support_local_files_and_globs_only() {
    let temp = tempfile::tempdir().expect("tempdir");
    fs::create_dir_all(temp.path().join("docs/nested")).expect("docs dir");
    fs::create_dir_all(temp.path().join("more/nested")).expect("more dir");
    fs::create_dir_all(temp.path().join(".opencode")).expect("opencode dir");
    fs::write(temp.path().join("docs/a.md"), "a\n").expect("a");
    fs::write(temp.path().join("docs/b.md"), "b\n").expect("b");
    fs::write(temp.path().join("docs/nested/c.md"), "c\n").expect("c");
    fs::write(temp.path().join("exact.txt"), "exact\n").expect("exact");
    fs::write(temp.path().join("more/nested/rule.md"), "nested rule\n").expect("nested rule");
    fs::write(
        temp.path().join("opencode.jsonc"),
        r#"{
          // Project-local declarative context only.
          "instructions": [
            "docs/*.md",
            "exact.txt",
            "https://example.invalid/rules.md",
            "../outside.md",
            "docs/a.md",
          ],
        }"#,
    )
    .expect("root config");
    fs::write(
        temp.path().join(".opencode/opencode.json"),
        r#"{"instructions":["more/**/*.md","exact.txt"]}"#,
    )
    .expect("directory config");

    let files = read_workspace_instruction_files(temp.path())
        .await
        .expect("instructions");

    assert_eq!(
        instruction_names(&files),
        vec!["docs/a.md", "docs/b.md", "exact.txt", "more/nested/rule.md",]
    );
    assert!(!files.iter().any(|file| file.name.contains("outside")));
    assert!(!files.iter().any(|file| file.name.starts_with("http")));
}

#[tokio::test]
async fn broad_opencode_globs_skip_vcs_dependency_and_build_directories() {
    let temp = tempfile::tempdir().expect("tempdir");
    for directory in ["docs", ".git", "node_modules/pkg", "target/debug"] {
        fs::create_dir_all(temp.path().join(directory)).expect("instruction directory");
    }
    fs::write(temp.path().join("docs/visible.md"), "visible\n").expect("visible");
    fs::write(temp.path().join(".git/private.md"), "private\n").expect("git file");
    fs::write(
        temp.path().join("node_modules/pkg/dependency.md"),
        "dependency\n",
    )
    .expect("dependency file");
    fs::write(temp.path().join("target/debug/output.md"), "output\n").expect("build file");
    fs::write(
        temp.path().join("opencode.json"),
        r#"{"instructions":["**/*.md"]}"#,
    )
    .expect("config");

    let files = read_workspace_instruction_files(temp.path())
        .await
        .expect("instructions");

    assert_eq!(instruction_names(&files), vec!["docs/visible.md"]);
}

#[tokio::test]
async fn declarative_instruction_expansion_has_a_file_budget() {
    let temp = tempfile::tempdir().expect("tempdir");
    fs::create_dir_all(temp.path().join("docs")).expect("docs");
    for index in 0..260 {
        fs::write(
            temp.path().join(format!("docs/{index:03}.md")),
            format!("rule {index}\n"),
        )
        .expect("instruction file");
    }
    fs::write(
        temp.path().join("opencode.json"),
        r#"{"instructions":["docs/*.md"]}"#,
    )
    .expect("config");

    let files = read_workspace_instruction_files(temp.path())
        .await
        .expect("instructions");

    assert_eq!(files.len(), 256);
}

#[tokio::test]
async fn path_scoped_claude_rules_consume_the_shared_read_budget() {
    let temp = tempfile::tempdir().expect("tempdir");
    fs::create_dir_all(temp.path().join(".claude/rules")).expect("rules");
    for index in 0..260 {
        fs::write(
            temp.path().join(format!(".claude/rules/{index:03}.md")),
            "---\npaths:\n  - src/**/*.rs\n---\nconditional\n",
        )
        .expect("path-scoped rule");
    }
    fs::write(
        temp.path().join("exact.md"),
        "must stay outside the budget\n",
    )
    .expect("exact");
    fs::write(
        temp.path().join("opencode.json"),
        r#"{"instructions":["exact.md"]}"#,
    )
    .expect("config");

    let files = read_workspace_instruction_files(temp.path())
        .await
        .expect("instructions");

    assert!(files.is_empty());
}

#[tokio::test]
async fn oversized_declarative_instruction_files_are_ignored() {
    let temp = tempfile::tempdir().expect("tempdir");
    fs::write(
        temp.path().join("oversized.md"),
        vec![b'x'; 1024 * 1024 + 1],
    )
    .expect("oversized file");
    fs::write(
        temp.path().join("opencode.json"),
        r#"{"instructions":["oversized.md"]}"#,
    )
    .expect("config");

    let files = read_workspace_instruction_files(temp.path())
        .await
        .expect("instructions");

    assert!(!files.iter().any(|file| file.name == "oversized.md"));
}
