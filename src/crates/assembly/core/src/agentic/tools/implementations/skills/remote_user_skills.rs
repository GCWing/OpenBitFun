//! Execution-host preference and on-demand deployment of local user Skills.

use super::types::{SkillData, SkillLocation};
use crate::agentic::workspace::WorkspaceFileSystem;
use crate::service::config::global::GlobalConfigManager;
use crate::service::config::types::{RemoteUserSkillsMode, WorkspaceConfig};
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use openbitfun_agent_runtime::skills::SkillResourceAvailability;
use std::sync::Arc;

pub type SkillLoadProgress = Arc<dyn Fn(String, Option<f32>) + Send + Sync>;

#[cfg(test)]
tokio::task_local! {
    // Keep per-call policy fixtures isolated from the process-global settings.
    pub(crate) static TEST_REMOTE_USER_SKILLS_MODE: RemoteUserSkillsMode;
}

pub(super) async fn remote_user_skills_mode() -> OpenBitFunResult<RemoteUserSkillsMode> {
    #[cfg(test)]
    if let Ok(mode) = TEST_REMOTE_USER_SKILLS_MODE.try_with(Clone::clone) {
        return Ok(mode);
    }
    // Read the runtime host's preference, including when a peer/mobile drives it.
    let service = GlobalConfigManager::get_service().await?;
    let config: WorkspaceConfig = service.get_config(Some("workspace")).await?;
    Ok(config.remote_user_skills)
}

pub(super) fn check_remote_user_skill_mode(mode: &RemoteUserSkillsMode) -> OpenBitFunResult<()> {
    match mode {
        RemoteUserSkillsMode::Disabled => Err(OpenBitFunError::tool(
            "Local user Skills are disabled in remote workspaces. Change Settings > Workspace & Git to enable them.".to_string(),
        )),
        RemoteUserSkillsMode::Unsupported(value) => Err(OpenBitFunError::tool(format!(
            "Unsupported remote user Skills mode '{value}'. Select a supported mode in Settings > Workspace & Git."
        ))),
        _ => Ok(()),
    }
}

pub(super) async fn prepare_remote_user_skill(
    skill: &mut SkillData,
    fs: &dyn WorkspaceFileSystem,
    remote_root: &str,
    progress: Option<SkillLoadProgress>,
    parser_source_slot: &str,
) -> OpenBitFunResult<()> {
    if skill.location == SkillLocation::Project {
        return Ok(());
    }
    let mode = remote_user_skills_mode().await?;
    prepare_remote_user_skill_with_mode(skill, fs, remote_root, progress, &mode, parser_source_slot)
        .await
}

async fn prepare_remote_user_skill_with_mode(
    skill: &mut SkillData,
    fs: &dyn WorkspaceFileSystem,
    remote_root: &str,
    progress: Option<SkillLoadProgress>,
    mode: &RemoteUserSkillsMode,
    parser_source_slot: &str,
) -> OpenBitFunResult<()> {
    check_remote_user_skill_mode(mode)?;
    if *mode == RemoteUserSkillsMode::SkillMdOnly {
        skill.resource_availability = Some(SkillResourceAvailability::MarkdownOnly);
        skill.compatibility_warnings.push(
            "Only SKILL.md was loaded from the runtime host. Its local scripts, references and templates are NOT available in this remote workspace. Do not read or execute those local paths remotely. Select Full in Settings > Workspace & Git to deploy the package before using its resources.".to_string(),
        );
        return Ok(());
    }
    if skill
        .entry_file
        .as_deref()
        .is_some_and(|entry| entry != "SKILL.md")
    {
        return Err(OpenBitFunError::tool(
            "Full remote loading is unsupported for standalone Markdown Skills without an isolated package directory. Move this Skill and its resources into a dedicated directory with SKILL.md, or select Only inject SKILL.md. The shared parent directory was not copied.",
        ));
    }
    #[cfg(feature = "remote-workspace")]
    {
        use openbitfun_services_core::skill_package_sync::{
            sync_local_skill_package, SkillPackageSyncPhase,
        };
        let notify = progress.map(|callback| {
            Arc::new(move |state: openbitfun_services_core::skill_package_sync::SkillPackageSyncProgress| {
                let stage = match state.phase {
                    SkillPackageSyncPhase::Scanning => "Preparing local Skill package",
                    SkillPackageSyncPhase::Checking => "Checking remote Skill package",
                    SkillPackageSyncPhase::Uploading => "Uploading Skill package",
                    SkillPackageSyncPhase::Verifying => "Verifying and publishing remote Skill package",
                    SkillPackageSyncPhase::Complete => "Remote Skill package ready",
                };
                let percentage = (state.phase == SkillPackageSyncPhase::Uploading && state.total_bytes > 0)
                    .then(|| (state.transferred_bytes as f32 / state.total_bytes as f32 * 100.0).min(100.0));
                let transfer = if state.phase == SkillPackageSyncPhase::Uploading {
                    format!(", {} bytes uploaded", state.transferred_bytes)
                } else { String::new() };
                callback(format!("{stage} ({} files, {} bytes{transfer}); large packages may take a while", state.file_count, state.total_bytes), percentage);
            }) as Arc<dyn Fn(_) + Send + Sync>
        });
        let cache_root = format!(
            "{}/.openbitfun/cache/user-skills",
            remote_root.trim_end_matches('/')
        );
        let deployment = sync_local_skill_package(
            std::path::Path::new(&skill.path),
            &cache_root,
            remote_root,
            &skill.key,
            fs,
            notify,
        )
        .await
        .map_err(|error| {
            OpenBitFunError::tool(format!(
                "Failed to deploy complete user Skill package: {error:#}"
            ))
        })?;

        // Read the deployed snapshot so the instructions and resources agree even
        // if the source directory changed during preparation. Paths stay POSIX.
        let entry = skill.entry_file.as_deref().unwrap_or("SKILL.md");
        let markdown = fs
            .read_file_text(&format!("{}/{entry}", deployment.path))
            .await
            .map_err(|error| {
                OpenBitFunError::tool(format!("Failed to read deployed Skill: {error}"))
            })?;
        // Dialects can derive an omitted name from the original directory/file.
        // The hash-named deployment is only an IO location, never Skill identity.
        let parser_path = if entry == "SKILL.md" {
            skill.path.clone()
        } else {
            format!("{}/{entry}", skill.path.trim_end_matches(['/', '\\']))
        };
        let mut deployed = SkillData::from_markdown_for_source_slot(
            parser_path,
            &markdown,
            skill.location,
            true,
            parser_source_slot,
        )
        .map_err(|error| OpenBitFunError::tool(error.to_string()))?;
        deployed.content = map_package_paths(&deployed.content, &skill.path, &deployment.path);
        skill.content = deployed.content;
        skill.name = deployed.name;
        skill.description = deployed.description;
        skill.hooks = deployed.hooks;
        skill.argument_names = deployed.argument_names;
        skill.argument_hint = deployed.argument_hint;
        skill.allow_implicit_invocation = deployed.allow_implicit_invocation;
        skill.allow_user_invocation = deployed.allow_user_invocation;
        skill.compatibility_warnings = deployed.compatibility_warnings;
        skill.path = deployment.path;
        skill.resource_availability = Some(SkillResourceAvailability::RemotePackage);
        skill.compatibility_warnings.push(
            "The complete Skill package is available at the remote path above. Use POSIX paths there; commands and project operations still run on the remote host. Runtime dependencies and files outside this Skill package are not installed or copied.".to_string(),
        );
        Ok(())
    }
    #[cfg(not(feature = "remote-workspace"))]
    {
        let _ = (skill, fs, remote_root, progress, parser_source_slot);
        Err(OpenBitFunError::tool(
            "This runtime build does not support complete user Skill deployment to remote workspaces.".to_string(),
        ))
    }
}

/// Rewrite references rooted in the source package, including Windows paths.
/// Other absolute paths remain unchanged: they are external dependencies.
#[cfg(any(test, feature = "remote-workspace"))]
fn map_package_paths(content: &str, source: &str, target: &str) -> String {
    let windows_source = (source.as_bytes().get(1) == Some(&b':')
        && source
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphabetic))
        || source.starts_with("\\\\");
    let mut prefixes = vec![source.to_string(), source.replace('\\', "/")];
    prefixes.retain(|prefix| !prefix.is_empty());
    prefixes.sort();
    prefixes.dedup();
    let mut mapped = String::new();
    let mut offset = 0;
    while let Some((index, prefix)) = prefixes
        .iter()
        .filter_map(|prefix| {
            content[offset..]
                .find(prefix)
                .map(|index| (offset + index, prefix))
        })
        .min_by_key(|(index, _)| *index)
    {
        mapped.push_str(&content[offset..index]);
        let after_start = index + prefix.len();
        let after = &content[after_start..];
        let before = &content[..index];
        if before.chars().next_back().is_some_and(|c| {
            !c.is_whitespace() && !matches!(c, '\'' | '"' | '`' | '(' | '<' | '[' | '=' | ':')
        }) {
            mapped.push_str(prefix);
            offset = after_start;
            continue;
        }
        let boundary = |c: char| {
            c.is_whitespace() || matches!(c, '\'' | '"' | '`' | ')' | ']' | '>' | ';' | ',')
        };
        if after.starts_with('/') || (windows_source && after.starts_with('\\')) {
            mapped.push_str(target);
            // Quoted resource names may contain spaces in any path component.
            let delimiter = enclosing_path_quote(before).or_else(|| {
                before
                    .chars()
                    .next_back()
                    .filter(|c| matches!(c, '\'' | '"' | '`' | '(' | '<'))
            });
            let end = match delimiter {
                Some('(') => after.find(')'),
                Some('<') => after.find('>'),
                Some(quote) => after.find(quote),
                None => after.find(boundary),
            }
            .unwrap_or(after.len());
            if windows_source {
                mapped.push_str(&after[..end].replace('\\', "/"));
            } else {
                // POSIX command text may escape spaces with backslashes. They
                // are shell syntax, not Windows directory separators.
                mapped.push_str(&after[..end]);
            }
            offset = after_start + end;
        } else if after.is_empty() || after.starts_with(boundary) {
            mapped.push_str(target);
            offset = after_start;
        } else {
            mapped.push_str(prefix);
            offset = after_start;
        }
    }
    mapped.push_str(&content[offset..]);
    mapped
}

#[cfg(any(test, feature = "remote-workspace"))]
fn enclosing_path_quote(before: &str) -> Option<char> {
    let mut quote = None;
    let mut inline_code = false;
    let mut escaped = false;
    let mut previous = None::<char>;
    let mut chars = before
        .rsplit('\n')
        .next()
        .unwrap_or_default()
        .chars()
        .peekable();
    while let Some(current) = chars.next() {
        if escaped {
            escaped = false;
        } else if quote == Some('\'') {
            if current == '\'' {
                quote = None;
            }
        } else if current == '\\' {
            escaped = true;
        } else if let Some(active) = quote {
            if current == active {
                quote = None;
            }
        } else if matches!(current, '\'' | '"') {
            // A possessive apostrophe in prose does not open a command token.
            if current != '\''
                || !previous.is_some_and(char::is_alphanumeric)
                || !chars.peek().is_some_and(|next| next.is_alphanumeric())
            {
                quote = Some(current);
            }
        } else if current == '`' {
            inline_code = !inline_code;
        }
        previous = Some(current);
    }
    quote.or(inline_code.then_some('`'))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user_skill(path: &str, markdown: &str, source: &str) -> SkillData {
        SkillData::from_markdown_for_source_slot(
            path.into(),
            markdown,
            SkillLocation::User,
            true,
            source,
        )
        .unwrap()
    }

    #[tokio::test]
    async fn markdown_only_warns_without_accessing_or_deploying_resources() {
        let mut skill = user_skill(
            "/nonexistent/local-skill",
            "---\nname: demo\ndescription: demo\n---\nRun scripts/hello.py",
            "openbitfun",
        );
        let original = skill.content.clone();
        prepare_remote_user_skill_with_mode(
            &mut skill,
            &crate::agentic::workspace::LocalWorkspaceFs,
            "/nonexistent/remote",
            None,
            &RemoteUserSkillsMode::SkillMdOnly,
            "openbitfun",
        )
        .await
        .unwrap();
        assert_eq!(skill.content, original);
        assert_eq!(skill.path, "/nonexistent/local-skill");
        assert_eq!(
            skill.resource_availability,
            Some(SkillResourceAvailability::MarkdownOnly)
        );
        assert!(skill
            .compatibility_warnings
            .iter()
            .any(|warning| warning.contains("NOT available")));
        let error = prepare_remote_user_skill_with_mode(
            &mut skill,
            &crate::agentic::workspace::LocalWorkspaceFs,
            "/nonexistent/remote",
            None,
            &RemoteUserSkillsMode::Disabled,
            "openbitfun",
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("disabled"));
    }

    #[tokio::test]
    async fn full_mode_rejects_flat_markdown_without_copying_shared_parent() {
        let mut skill = user_skill(
            "/user/shared-skills",
            "---\nname: standalone\ndescription: standalone\n---\nRead references/shared.md",
            "openbitfun",
        );
        skill.entry_file = Some("standalone.md".into());
        let error = prepare_remote_user_skill_with_mode(
            &mut skill,
            &crate::agentic::workspace::LocalWorkspaceFs,
            "/unavailable/remote",
            None,
            &RemoteUserSkillsMode::Full,
            "openbitfun",
        )
        .await
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("shared parent directory was not copied"));
        assert_eq!(skill.path, "/user/shared-skills");
    }

    #[cfg(all(unix, feature = "remote-workspace"))]
    #[tokio::test]
    async fn full_user_skill_loads_deployed_snapshot_and_preserves_dialect_identity() {
        use crate::agentic::workspace::{LocalWorkspaceFs, LocalWorkspaceShell, WorkspaceShell};
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("local user/review-package");
        let target = temp.path().join("remote project");
        std::fs::create_dir_all(source.join("scripts")).unwrap();
        std::fs::create_dir_all(source.join("references")).unwrap();
        std::fs::create_dir_all(&target).unwrap();
        let original = format!("---\ndescription: Review package\narguments: target\n---\nRead {}/references/guide.txt and run scripts/hello.sh for $target.", source.display());
        std::fs::write(source.join("SKILL.md"), &original).unwrap();
        std::fs::write(source.join("references/guide.txt"), "deployed reference").unwrap();
        std::fs::write(source.join("scripts/hello.sh"), "pwd -P\n").unwrap();
        let mut skill = user_skill(&source.to_string_lossy(), &original, "claude");
        let key = skill.key.clone();
        prepare_remote_user_skill_with_mode(
            &mut skill,
            &LocalWorkspaceFs,
            &target.to_string_lossy(),
            None,
            &RemoteUserSkillsMode::Full,
            "claude",
        )
        .await
        .unwrap();
        assert_eq!(skill.name, "review-package");
        assert_eq!(
            skill.resource_availability,
            Some(SkillResourceAvailability::RemotePackage)
        );
        assert_eq!(skill.key, key);
        assert_eq!(skill.argument_names, ["target"]);
        assert!(skill
            .path
            .starts_with(&target.to_string_lossy().to_string()));
        assert!(!skill.path.contains('\\'));
        assert!(skill
            .content
            .contains(&format!("{}/references/guide.txt", skill.path)));
        assert!(!skill
            .content
            .contains(&source.to_string_lossy().to_string()));
        assert_eq!(
            LocalWorkspaceFs
                .read_file_text(&format!("{}/references/guide.txt", skill.path))
                .await
                .unwrap(),
            "deployed reference"
        );
        let shell = LocalWorkspaceShell::new(target.to_string_lossy().into_owned());
        let (stdout, stderr, exit) = shell
            .exec(&format!("sh '{}/scripts/hello.sh'", skill.path), None)
            .await
            .unwrap();
        assert_eq!(exit, 0, "{stderr}");
        assert_eq!(
            stdout.trim(),
            std::fs::canonicalize(&target).unwrap().to_string_lossy()
        );
    }

    #[test]
    fn remote_user_skill_modes_fail_closed_for_disabled_and_future_values() {
        assert!(check_remote_user_skill_mode(&RemoteUserSkillsMode::Disabled).is_err());
        assert!(
            check_remote_user_skill_mode(&RemoteUserSkillsMode::Unsupported("future".to_string()))
                .is_err()
        );
        assert!(check_remote_user_skill_mode(&RemoteUserSkillsMode::SkillMdOnly).is_ok());
        assert!(check_remote_user_skill_mode(&RemoteUserSkillsMode::Full).is_ok());
    }

    #[test]
    fn source_package_paths_become_posix_without_rewriting_external_paths() {
        assert_eq!(
            map_package_paths(
                "python \"--config=C:\\skills\\demo\\my config\\settings.json\"",
                "C:\\skills\\demo",
                "/remote/demo",
            ),
            "python \"--config=/remote/demo/my config/settings.json\""
        );
        assert_eq!(
            map_package_paths(
                "`python \"--config=C:/skills/demo/my config\\settings.json\"`",
                "C:/skills/demo",
                "/remote/demo",
            ),
            "`python \"--config=/remote/demo/my config/settings.json\"`"
        );
        assert_eq!(
            map_package_paths(
                "python /local/skill/my\\ scripts/hello.py",
                "/local/skill",
                "/remote/skill",
            ),
            "python /remote/skill/my\\ scripts/hello.py"
        );
        assert_eq!(
            map_package_paths(
                "Read /backup/home/me/skill/references/x and /home/me/skill/references/x",
                "/home/me/skill",
                "/remote/cache",
            ),
            "Read /backup/home/me/skill/references/x and /remote/cache/references/x"
        );
        assert_eq!(
            map_package_paths(
                "python \"C:\\skills\\demo\\my scripts\\hello.py\"",
                "C:\\skills\\demo",
                "/remote/demo",
            ),
            "python \"/remote/demo/my scripts/hello.py\""
        );
        assert_eq!(
            map_package_paths(
                "Read /local/skill/references/a.md",
                "/local/skill",
                "/local/skill/cache",
            ),
            "Read /local/skill/cache/references/a.md"
        );
        assert_eq!(map_package_paths(
            "python \"C:\\Users\\Alice\\my skill\\scripts\\hello.py\"; see `C:/Users/Alice/my skill/references/doc.md`",
            "C:\\Users\\Alice\\my skill", "/remote/my-skill",
        ), "python \"/remote/my-skill/scripts/hello.py\"; see `/remote/my-skill/references/doc.md`");
        assert_eq!(
            map_package_paths(
                "Read /local/skill/references/a.md and /local/skill-extra/x and /other/file",
                "/local/skill",
                "/remote/skill",
            ),
            "Read /remote/skill/references/a.md and /local/skill-extra/x and /other/file"
        );
    }
}
