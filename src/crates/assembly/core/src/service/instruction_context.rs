use crate::util::errors::*;
use openbitfun_runtime_ports::WorkspaceFileSystem;
use openbitfun_services_core::local_instructions::LocalInstructionFile;
use openbitfun_services_core::workspace_instructions::WorkspaceInstructionFile;
use std::path::Path;

const MAX_RENDERED_INSTRUCTION_FILES: usize = 256;
const MAX_RENDERED_INSTRUCTION_BYTES: usize = 2 * 1024 * 1024;

pub(crate) struct InstructionContextBuild {
    pub(crate) content: Option<String>,
    pub(crate) cacheable: bool,
}

async fn load_user_instruction_files(workspace_root: &Path) -> (Vec<LocalInstructionFile>, bool) {
    #[cfg(feature = "external-sources")]
    {
        let files =
            crate::instruction_sources::load_local_user_instruction_files(workspace_root).await;
        return (files.files, files.cacheable);
    }
    #[cfg(not(feature = "external-sources"))]
    {
        let _ = workspace_root;
        (Vec::new(), true)
    }
}

async fn load_user_conditional_instruction_files() -> Vec<LocalInstructionFile> {
    #[cfg(feature = "external-sources")]
    {
        return crate::instruction_sources::load_local_user_conditional_instruction_sources().await;
    }
    #[cfg(not(feature = "external-sources"))]
    {
        Vec::new()
    }
}

pub(crate) async fn build_workspace_instruction_files_context(
    workspace_root: &Path,
) -> OpenBitFunResult<Option<String>> {
    Ok(
        build_workspace_instruction_files_context_detailed(workspace_root)
            .await?
            .content,
    )
}

pub(crate) async fn build_workspace_instruction_files_context_detailed(
    workspace_root: &Path,
) -> OpenBitFunResult<InstructionContextBuild> {
    let (user_instruction_files, user_instruction_files_cacheable) =
        load_user_instruction_files(workspace_root).await;
    let workspace_instruction_files =
        openbitfun_services_core::workspace_instructions::read_workspace_instruction_files(
            workspace_root,
        )
        .await
        .map_err(OpenBitFunError::service)?;
    Ok(compose_local_instruction_sources(
        workspace_root,
        user_instruction_files,
        user_instruction_files_cacheable,
        workspace_instruction_files,
    ))
}

pub(crate) async fn build_local_workspace_instruction_files_context_with_fs_detailed(
    workspace_root: &Path,
    fs: &dyn WorkspaceFileSystem,
    workspace_root_path: &str,
) -> OpenBitFunResult<InstructionContextBuild> {
    let (user_instruction_files, user_instruction_files_cacheable) =
        load_user_instruction_files(workspace_root).await;
    let workspace_instruction_files =
        openbitfun_services_core::workspace_instructions::read_workspace_instruction_files_with_fs(
            fs,
            workspace_root_path,
        )
        .await
        .map_err(OpenBitFunError::service)?;
    Ok(compose_local_instruction_sources(
        workspace_root,
        user_instruction_files,
        user_instruction_files_cacheable,
        workspace_instruction_files,
    ))
}

fn compose_local_instruction_sources(
    workspace_root: &Path,
    user_instruction_files: Vec<LocalInstructionFile>,
    user_instruction_files_cacheable: bool,
    workspace_instruction_files: Vec<WorkspaceInstructionFile>,
) -> InstructionContextBuild {
    let instruction_files = merge_local_instruction_sources(
        workspace_root,
        user_instruction_files,
        workspace_instruction_files,
    );
    InstructionContextBuild {
        content: render_workspace_instruction_files_section(&instruction_files),
        cacheable: user_instruction_files_cacheable,
    }
}

fn merge_local_instruction_sources(
    workspace_root: &Path,
    user_instruction_files: Vec<LocalInstructionFile>,
    mut workspace_instruction_files: Vec<WorkspaceInstructionFile>,
) -> Vec<WorkspaceInstructionFile> {
    openbitfun_services_core::workspace_instructions::retain_distinct_local_workspace_instruction_files(
        workspace_root,
        user_instruction_files
            .iter()
            .map(|file| file.canonical_path.clone()),
        &mut workspace_instruction_files,
    );
    let mut instruction_files = user_instruction_files
        .into_iter()
        .map(|file| WorkspaceInstructionFile {
            name: file.name,
            content: file.content,
            path_patterns: file.path_patterns,
        })
        .collect::<Vec<_>>();
    instruction_files.extend(workspace_instruction_files);
    instruction_files
}

pub(crate) async fn load_local_conditional_instruction_files(
    workspace_root: &Path,
) -> OpenBitFunResult<Vec<WorkspaceInstructionFile>> {
    let user_instruction_files = load_user_conditional_instruction_files().await;
    let workspace_instruction_files =
        openbitfun_services_core::workspace_instructions::read_workspace_conditional_instruction_sources(
            workspace_root,
        )
        .await
        .map_err(OpenBitFunError::service)?;
    Ok(merge_local_instruction_sources(
        workspace_root,
        user_instruction_files,
        workspace_instruction_files,
    ))
}

pub(crate) async fn load_local_conditional_instruction_files_with_fs(
    workspace_root: &Path,
    fs: &dyn WorkspaceFileSystem,
    workspace_root_path: &str,
) -> OpenBitFunResult<Vec<WorkspaceInstructionFile>> {
    let user_instruction_files = load_user_conditional_instruction_files().await;
    let workspace_instruction_files =
        openbitfun_services_core::workspace_instructions::read_workspace_conditional_instruction_sources_with_fs(
            fs,
            workspace_root_path,
        )
        .await
        .map_err(OpenBitFunError::service)?;
    Ok(merge_local_instruction_sources(
        workspace_root,
        user_instruction_files,
        workspace_instruction_files,
    ))
}

pub(crate) async fn load_workspace_conditional_instruction_files_with_fs(
    fs: &dyn WorkspaceFileSystem,
    workspace_root: &str,
) -> OpenBitFunResult<Vec<WorkspaceInstructionFile>> {
    Ok(openbitfun_services_core::workspace_instructions::read_workspace_conditional_instruction_sources_with_fs(
            fs,
            workspace_root,
        )
        .await
        .map_err(OpenBitFunError::service)?)
}

pub(crate) async fn build_workspace_instruction_files_context_with_fs(
    fs: &dyn WorkspaceFileSystem,
    workspace_root: &str,
) -> OpenBitFunResult<Option<String>> {
    let instruction_files =
        openbitfun_services_core::workspace_instructions::read_workspace_instruction_files_with_fs(
            fs,
            workspace_root,
        )
        .await
        .map_err(OpenBitFunError::service)?;
    Ok(render_workspace_instruction_files_section(
        &instruction_files,
    ))
}

fn render_workspace_instruction_files_section(
    files: &[WorkspaceInstructionFile],
) -> Option<String> {
    render_instruction_documents(
        "## Codebase and user instructions\n\nBe sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.\n",
        files.iter().filter(|file| file.path_patterns.is_empty()),
    )
    .0
}

pub(crate) fn render_instruction_documents<'a>(
    header: &str,
    files: impl IntoIterator<Item = &'a WorkspaceInstructionFile>,
) -> (Option<String>, Vec<String>) {
    let mut rendered = String::from(header);
    let mut rendered_names = Vec::new();

    for file in files.into_iter().take(MAX_RENDERED_INSTRUCTION_FILES) {
        let escaped_name = escape_document_name(&file.name);
        let document = format!(
            "<document name=\"{}\">\n{}\n</document>\n\n",
            escaped_name,
            file.content.trim()
        );
        if rendered.len().saturating_add(document.len()) > MAX_RENDERED_INSTRUCTION_BYTES {
            break;
        }
        rendered.push_str(&document);
        rendered_names.push(file.name.clone());
    }

    (
        (!rendered_names.is_empty()).then(|| rendered.trim_end().to_string()),
        rendered_names,
    )
}

fn escape_document_name(name: &str) -> String {
    name.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

#[cfg(test)]
mod tests {
    #[cfg(feature = "external-sources")]
    use super::{
        build_workspace_instruction_files_context,
        build_workspace_instruction_files_context_detailed,
        build_workspace_instruction_files_context_with_fs,
        load_local_conditional_instruction_files,
    };
    use super::{render_workspace_instruction_files_section, WorkspaceInstructionFile};
    #[cfg(feature = "external-sources")]
    use crate::instruction_sources::test_support::{lock_environment, EnvironmentGuard};
    #[cfg(feature = "external-sources")]
    use openbitfun_services_core::workspace::LocalWorkspaceFs;

    #[cfg(feature = "external-sources")]
    #[tokio::test]
    async fn local_user_instructions_precede_workspace_instructions_by_ecosystem_priority() {
        let _environment = lock_environment();
        let temp = tempfile::tempdir().expect("tempdir");
        let workspace = temp.path().join("workspace");
        let xdg = temp.path().join("xdg");
        let codex = temp.path().join("codex");
        let claude = temp.path().join("claude");
        std::fs::create_dir_all(xdg.join("opencode")).expect("OpenCode config directory");
        std::fs::create_dir_all(&codex).expect("Codex config directory");
        std::fs::create_dir_all(&claude).expect("Claude config directory");
        std::fs::create_dir_all(&workspace).expect("workspace directory");
        std::fs::write(xdg.join("opencode/AGENTS.md"), "OpenCode user\n")
            .expect("OpenCode instructions");
        std::fs::write(codex.join("AGENTS.md"), "Codex user\n").expect("Codex instructions");
        std::fs::write(claude.join("CLAUDE.md"), "Claude user\n").expect("Claude instructions");
        std::fs::write(workspace.join("AGENTS.md"), "Workspace project\n")
            .expect("workspace instructions");
        let _guard = EnvironmentGuard::set(&[
            ("XDG_CONFIG_HOME", &xdg),
            ("CODEX_HOME", &codex),
            ("CLAUDE_CONFIG_DIR", &claude),
        ]);

        let rendered = build_workspace_instruction_files_context(&workspace)
            .await
            .expect("instruction context")
            .expect("rendered instructions");

        let positions = [
            rendered
                .find("OpenCode user")
                .expect("OpenCode instructions"),
            rendered.find("Codex user").expect("Codex instructions"),
            rendered.find("Claude user").expect("Claude instructions"),
            rendered
                .find("Workspace project")
                .expect("workspace instructions"),
        ];
        assert!(positions.windows(2).all(|pair| pair[0] < pair[1]));
    }

    #[cfg(feature = "external-sources")]
    #[tokio::test]
    async fn workspace_instruction_family_priority_applies_to_context_and_conditional_sources() {
        let _environment = lock_environment();
        let temp = tempfile::tempdir().expect("tempdir");
        let workspace = temp.path().join("workspace");
        let xdg = temp.path().join("xdg");
        let codex = temp.path().join("codex");
        let claude = temp.path().join("claude");
        std::fs::create_dir_all(workspace.join(".claude/rules")).unwrap();
        std::fs::write(workspace.join("AGENTS.override.md"), " \n\t").unwrap();
        std::fs::write(workspace.join("AGENTS.md"), "Project AGENTS rules\n").unwrap();
        std::fs::write(workspace.join("CLAUDE.md"), "Project Claude rules\n").unwrap();
        std::fs::write(
            workspace.join(".claude/rules/rust.md"),
            "---\npaths: [\"src/**/*.rs\"]\n---\nProject conditional rules\n",
        )
        .unwrap();
        std::fs::write(
            workspace.join("opencode.json"),
            r#"{"instructions":["opencode-guide.md"]}"#,
        )
        .unwrap();
        std::fs::write(
            workspace.join("opencode-guide.md"),
            "Project OpenCode rules",
        )
        .unwrap();
        let _guard = EnvironmentGuard::set(&[
            ("XDG_CONFIG_HOME", &xdg),
            ("CODEX_HOME", &codex),
            ("CLAUDE_CONFIG_DIR", &claude),
        ]);

        let context = build_workspace_instruction_files_context_detailed(&workspace)
            .await
            .unwrap();
        assert!(context.cacheable);
        let rendered = context.content.unwrap();
        assert!(rendered.contains("Project AGENTS rules"));
        assert!(!rendered.contains("Project Claude rules"));
        assert!(!rendered.contains("Project conditional rules"));
        assert!(!rendered.contains("Project OpenCode rules"));
        assert!(load_local_conditional_instruction_files(&workspace)
            .await
            .unwrap()
            .is_empty());

        std::fs::write(workspace.join("opencode.json"), "{ invalid config").unwrap();
        assert!(
            build_workspace_instruction_files_context_detailed(&workspace)
                .await
                .unwrap()
                .cacheable
        );
        std::fs::write(workspace.join("AGENTS.md"), "").unwrap();
        let context = build_workspace_instruction_files_context(&workspace)
            .await
            .unwrap()
            .unwrap();
        assert!(context.contains("Project Claude rules"));
        assert!(!context.contains("Project conditional rules"));
        let conditional = load_local_conditional_instruction_files(&workspace)
            .await
            .unwrap();
        assert_eq!(conditional.len(), 1);
        assert_eq!(conditional[0].name, ".claude/rules/rust.md");
    }

    #[cfg(feature = "external-sources")]
    #[tokio::test]
    async fn openbitfun_user_instructions_replace_codex_with_missing_and_blank_fallbacks() {
        let _environment = lock_environment();
        let temp = tempfile::tempdir().expect("tempdir");
        let workspace = temp.path().join("workspace");
        let native = temp.path().join("openbitfun");
        let codex = temp.path().join("codex");
        let claude = temp.path().join("claude");
        let xdg = temp.path().join("xdg");
        for directory in [&workspace, &native, &codex, &claude, &xdg.join("opencode")] {
            std::fs::create_dir_all(directory).expect("instruction directory");
        }
        std::fs::write(native.join("AGENTS.md"), "Native user instructions\n").unwrap();
        std::fs::write(codex.join("AGENTS.md"), "Codex base instructions\n").unwrap();
        // An invalid override proves that the Codex reader is never called
        // while a non-empty native file is selected.
        std::fs::write(codex.join("AGENTS.override.md"), [0xff]).unwrap();
        std::fs::write(claude.join("CLAUDE.md"), "Claude user instructions\n").unwrap();
        std::fs::write(
            xdg.join("opencode/AGENTS.md"),
            "OpenCode user instructions\n",
        )
        .unwrap();
        std::fs::write(workspace.join("AGENTS.md"), "Workspace instructions\n").unwrap();
        let _guard = EnvironmentGuard::set(&[
            ("OPENBITFUN_HOME", &native),
            ("CODEX_HOME", &codex),
            ("CLAUDE_CONFIG_DIR", &claude),
            ("XDG_CONFIG_HOME", &xdg),
        ]);

        let build = build_workspace_instruction_files_context_detailed(&workspace)
            .await
            .expect("native instruction context");
        assert!(build.cacheable);
        let rendered = build.content.expect("rendered instructions");
        assert!(rendered.contains("<document name=\"$OPENBITFUN_HOME/AGENTS.md\">"));
        assert!(!rendered.contains("Codex base instructions"));
        let positions = [
            "OpenCode user instructions",
            "Native user instructions",
            "Claude user instructions",
            "Workspace instructions",
        ]
        .map(|content| rendered.find(content).expect(content));
        assert!(positions.windows(2).all(|pair| pair[0] < pair[1]));
        let catalog =
            crate::instruction_sources::instruction_source_catalog(Some(&workspace)).await;
        assert!(catalog.failed_ecosystems.is_empty());
        assert!(catalog.entries.iter().any(|entry| {
            entry.ecosystem_id == "openbitfun"
                && entry.name == "$OPENBITFUN_HOME/AGENTS.md"
                && entry.scope == "user"
        }));
        assert!(!catalog
            .entries
            .iter()
            .any(|entry| entry.ecosystem_id == "codex"));

        std::fs::write(
            codex.join("AGENTS.override.md"),
            "Codex override instructions\n",
        )
        .unwrap();
        for content in [None, Some(""), Some(" \n\t")] {
            if let Some(content) = content {
                std::fs::write(native.join("AGENTS.md"), content).unwrap();
            } else {
                std::fs::remove_file(native.join("AGENTS.md")).unwrap();
            }
            let rendered = build_workspace_instruction_files_context(&workspace)
                .await
                .expect("legacy Codex fallback")
                .expect("rendered fallback");
            assert!(rendered.contains("Codex override instructions"));
            assert!(!rendered.contains("Native user instructions"));
            let catalog =
                crate::instruction_sources::instruction_source_catalog(Some(&workspace)).await;
            assert!(catalog.failed_ecosystems.is_empty());
            assert!(catalog
                .entries
                .iter()
                .any(|entry| entry.ecosystem_id == "codex"));
            assert!(!catalog
                .entries
                .iter()
                .any(|entry| entry.ecosystem_id == "openbitfun"));
        }
    }

    #[cfg(feature = "external-sources")]
    #[tokio::test]
    async fn invalid_openbitfun_user_instructions_preserve_workspace_and_retry_without_codex() {
        let _environment = lock_environment();
        let temp = tempfile::tempdir().expect("tempdir");
        let workspace = temp.path().join("workspace");
        let native = temp.path().join("openbitfun");
        let codex = temp.path().join("codex");
        let claude = temp.path().join("claude");
        let xdg = temp.path().join("xdg");
        for directory in [&workspace, &native, &codex, &claude, &xdg] {
            std::fs::create_dir_all(directory).expect("instruction directory");
        }
        std::fs::write(native.join("AGENTS.md"), [0xff]).unwrap();
        std::fs::write(codex.join("AGENTS.md"), "Codex must stay absent\n").unwrap();
        std::fs::write(workspace.join("AGENTS.md"), "Workspace survives\n").unwrap();
        let _guard = EnvironmentGuard::set(&[
            ("OPENBITFUN_HOME", &native),
            ("CODEX_HOME", &codex),
            ("CLAUDE_CONFIG_DIR", &claude),
            ("XDG_CONFIG_HOME", &xdg),
        ]);

        let build = build_workspace_instruction_files_context_detailed(&workspace)
            .await
            .expect("workspace survives native failure");
        assert!(!build.cacheable);
        let rendered = build.content.expect("workspace instructions");
        assert!(rendered.contains("Workspace survives"));
        assert!(!rendered.contains("Codex must stay absent"));
        let catalog =
            crate::instruction_sources::instruction_source_catalog(Some(&workspace)).await;
        assert_eq!(catalog.failed_ecosystems, ["openbitfun"]);

        std::fs::write(native.join("AGENTS.md"), "Repaired native instructions\n").unwrap();
        let retry = build_workspace_instruction_files_context_detailed(&workspace)
            .await
            .expect("native instructions retried");
        assert!(retry.cacheable);
        assert!(retry
            .content
            .unwrap()
            .contains("Repaired native instructions"));
    }

    #[cfg(feature = "external-sources")]
    #[tokio::test]
    async fn conditional_instructions_keep_user_then_workspace_precedence() {
        let _environment = lock_environment();
        let temp = tempfile::tempdir().expect("tempdir");
        let workspace = temp.path().join("workspace");
        let xdg = temp.path().join("xdg");
        let codex = temp.path().join("codex");
        let claude = temp.path().join("claude");
        std::fs::create_dir_all(xdg.join("opencode")).expect("OpenCode config directory");
        std::fs::create_dir_all(&codex).expect("Codex config directory");
        std::fs::create_dir_all(claude.join("rules")).expect("Claude rules directory");
        std::fs::create_dir_all(workspace.join(".claude/rules"))
            .expect("workspace rules directory");
        std::fs::write(
            claude.join("rules/user.md"),
            "---\npaths:\n  - src/**/*.rs\n---\nUser rule\n",
        )
        .expect("user rule");
        std::fs::write(
            workspace.join(".claude/rules/project.md"),
            "---\npaths:\n  - src/**/*.rs\n---\nProject rule\n",
        )
        .expect("project rule");
        let _guard = EnvironmentGuard::set(&[
            ("XDG_CONFIG_HOME", &xdg),
            ("CODEX_HOME", &codex),
            ("CLAUDE_CONFIG_DIR", &claude),
        ]);

        let files = load_local_conditional_instruction_files(&workspace)
            .await
            .expect("conditional instructions");

        assert_eq!(
            files
                .iter()
                .map(|file| file.name.as_str())
                .collect::<Vec<_>>(),
            vec![
                "$CLAUDE_CONFIG_DIR/rules/user.md",
                ".claude/rules/project.md"
            ]
        );
    }

    #[cfg(feature = "external-sources")]
    #[tokio::test]
    async fn invalid_user_rule_does_not_hide_project_conditional_instructions() {
        let _environment = lock_environment();
        let temp = tempfile::tempdir().expect("tempdir");
        let workspace = temp.path().join("workspace");
        let xdg = temp.path().join("xdg");
        let codex = temp.path().join("codex");
        let claude = temp.path().join("claude");
        std::fs::create_dir_all(xdg.join("opencode")).expect("OpenCode config directory");
        std::fs::create_dir_all(&codex).expect("Codex config directory");
        std::fs::create_dir_all(claude.join("rules")).expect("Claude rules directory");
        std::fs::create_dir_all(workspace.join(".claude/rules"))
            .expect("workspace rules directory");
        std::fs::write(
            claude.join("rules/oversized.md"),
            vec![
                b'x';
                openbitfun_services_core::local_instructions::MAX_LOCAL_INSTRUCTION_FILE_BYTES + 1
            ],
        )
        .expect("oversized user rule");
        std::fs::write(
            workspace.join(".claude/rules/project.md"),
            "---\npaths:\n  - src/**/*.rs\n---\nProject rule\n",
        )
        .expect("project rule");
        let _guard = EnvironmentGuard::set(&[
            ("XDG_CONFIG_HOME", &xdg),
            ("CODEX_HOME", &codex),
            ("CLAUDE_CONFIG_DIR", &claude),
        ]);

        let files = load_local_conditional_instruction_files(&workspace)
            .await
            .expect("project conditional instructions");

        assert_eq!(files.len(), 1);
        assert_eq!(files[0].name, ".claude/rules/project.md");
    }

    #[cfg(feature = "external-sources")]
    #[tokio::test]
    async fn opencode_global_config_resolves_relative_instructions_in_the_local_workspace() {
        let _environment = lock_environment();
        let temp = tempfile::tempdir().expect("tempdir");
        let workspace = temp.path().join("workspace");
        let xdg = temp.path().join("xdg");
        let codex = temp.path().join("codex");
        let claude = temp.path().join("claude");
        std::fs::create_dir_all(xdg.join("opencode")).expect("OpenCode config directory");
        std::fs::create_dir_all(&codex).expect("Codex config directory");
        std::fs::create_dir_all(&claude).expect("Claude config directory");
        std::fs::create_dir_all(workspace.join("shared")).expect("workspace shared directory");
        std::fs::write(xdg.join("opencode/AGENTS.md"), "OpenCode user\n")
            .expect("OpenCode instructions");
        std::fs::write(
            xdg.join("opencode/opencode.json"),
            r#"{"instructions":["shared/*.md"]}"#,
        )
        .expect("OpenCode config");
        std::fs::write(
            workspace.join("shared/team.md"),
            "Shared workspace policy\n",
        )
        .expect("configured workspace instructions");
        let _guard = EnvironmentGuard::set(&[
            ("XDG_CONFIG_HOME", &xdg),
            ("CODEX_HOME", &codex),
            ("CLAUDE_CONFIG_DIR", &claude),
        ]);

        let rendered = build_workspace_instruction_files_context(&workspace)
            .await
            .expect("instruction context")
            .expect("rendered instructions");

        assert!(rendered.contains("Shared workspace policy"));
        assert!(rendered.contains("<document name=\"&lt;workspace&gt;/shared/team.md\">"));
    }

    #[cfg(feature = "external-sources")]
    #[tokio::test]
    async fn invalid_user_source_does_not_hide_workspace_instructions() {
        let _environment = lock_environment();
        let temp = tempfile::tempdir().expect("tempdir");
        let workspace = temp.path().join("workspace");
        let xdg = temp.path().join("xdg");
        let codex = temp.path().join("codex");
        let claude = temp.path().join("claude");
        std::fs::create_dir_all(xdg.join("opencode")).expect("OpenCode config directory");
        std::fs::create_dir_all(&codex).expect("Codex config directory");
        std::fs::create_dir_all(&claude).expect("Claude config directory");
        std::fs::create_dir_all(&workspace).expect("workspace directory");
        std::fs::write(xdg.join("opencode/AGENTS.md"), "OpenCode user\n")
            .expect("OpenCode instructions");
        std::fs::write(xdg.join("opencode/opencode.json"), "{ invalid json")
            .expect("invalid OpenCode config");
        std::fs::write(workspace.join("AGENTS.md"), "Workspace survives\n")
            .expect("workspace instructions");
        let _guard = EnvironmentGuard::set(&[
            ("XDG_CONFIG_HOME", &xdg),
            ("CODEX_HOME", &codex),
            ("CLAUDE_CONFIG_DIR", &claude),
        ]);

        let build = build_workspace_instruction_files_context_detailed(&workspace)
            .await
            .expect("workspace instructions survive user source failure");
        let rendered = build.content.expect("rendered instructions");

        assert!(rendered.contains("Workspace survives"));
        assert!(!build.cacheable);
    }

    #[cfg(feature = "external-sources")]
    #[tokio::test]
    async fn a_user_configured_workspace_file_is_not_rendered_again_as_a_project_source() {
        let _environment = lock_environment();
        let temp = tempfile::tempdir().expect("tempdir");
        let workspace = temp.path().join("workspace");
        let xdg = temp.path().join("xdg");
        let codex = temp.path().join("codex");
        let claude = temp.path().join("claude");
        std::fs::create_dir_all(xdg.join("opencode")).expect("OpenCode config directory");
        std::fs::create_dir_all(&codex).expect("Codex config directory");
        std::fs::create_dir_all(&claude).expect("Claude config directory");
        std::fs::create_dir_all(&workspace).expect("workspace directory");
        std::fs::write(
            xdg.join("opencode/opencode.json"),
            r#"{"instructions":["AGENTS.md"]}"#,
        )
        .expect("OpenCode config");
        std::fs::write(workspace.join("AGENTS.md"), "One physical source\n")
            .expect("workspace instructions");
        let _guard = EnvironmentGuard::set(&[
            ("XDG_CONFIG_HOME", &xdg),
            ("CODEX_HOME", &codex),
            ("CLAUDE_CONFIG_DIR", &claude),
        ]);

        let rendered = build_workspace_instruction_files_context(&workspace)
            .await
            .expect("instruction context")
            .expect("rendered instructions");

        assert_eq!(rendered.matches("One physical source").count(), 1);
    }

    #[cfg(feature = "external-sources")]
    #[tokio::test]
    async fn port_backed_workspace_never_falls_back_to_local_user_sources() {
        let _environment = lock_environment();
        let temp = tempfile::tempdir().expect("tempdir");
        let workspace = temp.path().join("workspace");
        let xdg = temp.path().join("xdg");
        let codex = temp.path().join("codex");
        let claude = temp.path().join("claude");
        let native = temp.path().join("openbitfun");
        std::fs::create_dir_all(xdg.join("opencode")).expect("OpenCode config directory");
        std::fs::create_dir_all(&codex).expect("Codex config directory");
        std::fs::create_dir_all(&claude).expect("Claude config directory");
        std::fs::create_dir_all(&native).expect("OpenBitFun home directory");
        std::fs::write(native.join("AGENTS.md"), "Local native must stay absent\n")
            .expect("native instructions");
        std::fs::create_dir_all(&workspace).expect("workspace directory");
        std::fs::write(
            xdg.join("opencode/AGENTS.md"),
            "Local user must stay absent\n",
        )
        .expect("OpenCode instructions");
        std::fs::write(workspace.join("AGENTS.md"), "Port project instructions\n")
            .expect("workspace instructions");
        let _guard = EnvironmentGuard::set(&[
            ("OPENBITFUN_HOME", &native),
            ("XDG_CONFIG_HOME", &xdg),
            ("CODEX_HOME", &codex),
            ("CLAUDE_CONFIG_DIR", &claude),
        ]);
        let root = workspace.to_string_lossy();

        let rendered = build_workspace_instruction_files_context_with_fs(&LocalWorkspaceFs, &root)
            .await
            .expect("port-backed instruction context")
            .expect("rendered instructions");

        assert!(rendered.contains("Port project instructions"));
        assert!(!rendered.contains("Local user must stay absent"));
        assert!(!rendered.contains("Local native must stay absent"));
    }

    #[test]
    fn rendered_document_names_escape_markup_characters() {
        let rendered = render_workspace_instruction_files_section(&[WorkspaceInstructionFile {
            name: "<configured-path>/team\"&.md".to_string(),
            content: "Team instructions".to_string(),
            path_patterns: Vec::new(),
        }])
        .expect("rendered instructions");

        assert!(rendered.contains("<document name=\"&lt;configured-path&gt;/team&quot;&amp;.md\">"));
        assert!(!rendered.contains("name=\"<configured-path>"));
    }

    #[test]
    fn rendered_instruction_context_keeps_one_shared_content_budget() {
        let files = (0..3)
            .map(|index| WorkspaceInstructionFile {
                name: format!("source-{index}.md"),
                content: format!("source-{index}\n{}", "x".repeat(700 * 1024)),
                path_patterns: Vec::new(),
            })
            .collect::<Vec<_>>();

        let rendered =
            render_workspace_instruction_files_section(&files).expect("rendered instructions");

        assert!(rendered.len() <= 2 * 1024 * 1024);
        assert!(rendered.contains("source-0\n"));
        assert!(rendered.contains("source-1\n"));
        assert!(!rendered.contains("source-2\n"));
    }

    #[test]
    fn rendered_instruction_context_keeps_one_shared_file_budget() {
        let files = (0..257)
            .map(|index| WorkspaceInstructionFile {
                name: format!("source-{index}.md"),
                content: format!("instruction {index}"),
                path_patterns: Vec::new(),
            })
            .collect::<Vec<_>>();

        let rendered =
            render_workspace_instruction_files_section(&files).expect("rendered instructions");

        assert_eq!(rendered.matches("<document name=").count(), 256);
        assert!(!rendered.contains("instruction 256"));
    }
}
