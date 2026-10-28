use crate::agentic::agents::{
    get_agent_registry, AgentInfo, SubagentListScope, SubagentQueryContext,
};
use crate::agentic::tools::framework::ToolUseContext;
use crate::agentic::tools::implementations::skills::get_skill_registry;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use openbitfun_agent_runtime::skills::{SkillData, SkillInfo, SkillLocation};
use sha2::{Digest, Sha256};

const CAPABILITY_CATALOG_LIMIT: usize = 24;
const CAPABILITY_TITLE_LIMIT: usize = 80;
const CAPABILITY_DESCRIPTION_LIMIT: usize = 240;
const SELECTED_GUIDANCE_LIMIT: usize = 12_000;
const BUILTIN_CAPABILITY_KEY: &str = "builtin::review-worker";
const BUILTIN_GUIDANCE: &str = "Perform an independent, evidence-first review of the assigned question. Inspect only the minimum changed files needed for that question, use unchanged dependencies only when they are necessary to prove a call path or contract, and return concrete findings with file and line evidence. Do not broaden the assignment or delegate again.";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewCapabilityDescriptor {
    key: String,
    title: String,
    description: String,
    fingerprint: String,
}

impl ReviewCapabilityDescriptor {
    fn new(key: &str, title: &str, description: &str, fingerprint_material: &str) -> Self {
        let title = truncate_chars(title.trim(), CAPABILITY_TITLE_LIMIT);
        let description = truncate_chars(description.trim(), CAPABILITY_DESCRIPTION_LIMIT);
        let fingerprint = hex::encode(Sha256::digest(
            format!("{key}\0{title}\0{description}\0{fingerprint_material}").as_bytes(),
        ));
        Self {
            key: key.to_string(),
            title,
            description,
            fingerprint,
        }
    }

    pub fn key(&self) -> &str {
        &self.key
    }

    pub fn fingerprint(&self) -> &str {
        &self.fingerprint
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedReviewCapability {
    pub guidance: String,
    pub preferred_model: Option<String>,
}

pub async fn review_capability_catalog(
    context: &ToolUseContext,
) -> Vec<ReviewCapabilityDescriptor> {
    let mut descriptors = vec![ReviewCapabilityDescriptor::new(
        BUILTIN_CAPABILITY_KEY,
        "Independent review",
        "A general evidence-first check for a concrete unresolved concern.",
        BUILTIN_GUIDANCE,
    )];

    let skills = implicitly_invocable_skills(context).await;
    let mut skills = skills
        .into_iter()
        .filter(|skill| is_compatible_review_skill(&skill.dir_name))
        .collect::<Vec<_>>();
    skills.sort_by(|left, right| left.key.cmp(&right.key));

    let mut agents = get_agent_registry()
        .get_subagents_for_query(&SubagentQueryContext {
            parent_agent_type: context.agent_type.as_deref(),
            workspace_id: (!context.is_remote())
                .then(|| context.workspace_id())
                .flatten(),
            list_scope: SubagentListScope::TaskVisible,
            include_disabled: false,
            external_sources_supported: false,
        })
        .await
        .into_iter()
        .filter(|agent| {
            agent.path.is_some()
                && agent.is_readonly
                && agent.is_review
                && !matches!(
                    agent.id.as_str(),
                    "ReviewWorker"
                        | "ReviewJudge"
                        | "ReviewGeneral"
                        | "ReviewBusinessLogic"
                        | "ReviewSecurity"
                        | "ReviewArchitecture"
                        | "ReviewFrontend"
                        | "ReviewPerformance"
                        | "ReviewTesting"
                        | "CodeReview"
                        | "DeepReview"
                        | "ReviewFixer"
                )
        })
        .collect::<Vec<_>>();
    agents.sort_by(|left, right| left.key.cmp(&right.key));

    let (skill_limit, agent_limit) = catalog_source_limits(skills.len(), agents.len());
    for skill in skills.into_iter().take(skill_limit) {
        let Ok(skill) = load_discovered_review_skill(context, &skill).await else {
            continue;
        };
        let Ok(guidance) = bounded_selected_guidance(&skill.content) else {
            continue;
        };
        descriptors.push(ReviewCapabilityDescriptor::new(
            &format!("skill:{}", skill.key),
            &skill.name,
            &skill.description,
            &guidance,
        ));
    }

    let workspace_root = (!context.is_remote())
        .then(|| context.workspace_id())
        .flatten();
    for agent in agents.into_iter().take(agent_limit) {
        let Ok(detail) = get_agent_registry()
            .get_custom_subagent_detail_by_key(&agent.key, workspace_root)
            .await
        else {
            continue;
        };
        if !detail.readonly || !detail.review {
            continue;
        }
        let Ok(guidance) = bounded_selected_guidance(&detail.prompt) else {
            continue;
        };
        let preferred_model = explicit_preferred_model(&agent);
        descriptors.push(ReviewCapabilityDescriptor::new(
            &format!("agent:{}", agent.key),
            &detail.name,
            &detail.description,
            &agent_fingerprint_material(&guidance, preferred_model.as_deref()),
        ));
    }

    descriptors
}

async fn implicitly_invocable_skills(context: &ToolUseContext) -> Vec<SkillInfo> {
    let skill_registry = get_skill_registry();
    if context.is_remote() {
        if let Some(fs) = context.ws_fs() {
            let root = context
                .workspace
                .as_ref()
                .map(|workspace| workspace.root_path_string())
                .unwrap_or_default();
            skill_registry
                .get_implicitly_invocable_skills_for_remote_workspace(
                    fs,
                    &root,
                    context.agent_type.as_deref(),
                )
                .await
        } else {
            Vec::new()
        }
    } else {
        skill_registry
            .get_implicitly_invocable_skills_for_workspace(
                context.workspace.as_ref(),
                context.agent_type.as_deref(),
            )
            .await
    }
}

pub async fn review_capability_catalog_for_context(context: &ToolUseContext) -> String {
    render_review_capability_catalog(&review_capability_catalog(context).await)
}

pub async fn resolve_review_capability(
    context: &ToolUseContext,
    key: &str,
    fingerprint: &str,
) -> OpenBitFunResult<ResolvedReviewCapability> {
    if key == BUILTIN_CAPABILITY_KEY {
        ensure_capability_fingerprint(
            &ReviewCapabilityDescriptor::new(
                BUILTIN_CAPABILITY_KEY,
                "Independent review",
                "A general evidence-first check for a concrete unresolved concern.",
                BUILTIN_GUIDANCE,
            ),
            fingerprint,
        )?;
        return Ok(ResolvedReviewCapability {
            guidance: BUILTIN_GUIDANCE.to_string(),
            preferred_model: None,
        });
    }
    if let Some(skill_key) = key.strip_prefix("skill:") {
        let remote_user_source = if context.is_remote() {
            implicitly_invocable_skills(context)
                .await
                .into_iter()
                .find(|skill| skill.key == skill_key && skill.level == SkillLocation::User)
        } else {
            None
        };
        if let Some(info) = &remote_user_source {
            let preview = load_discovered_review_skill(context, info).await?;
            verify_review_skill_fingerprint(key, &preview, fingerprint)?;
            // Remote command hooks are unsupported. Check the same contract as
            // SkillTool before spending time deploying an unusable package.
            crate::native_hooks::activate_skill_hooks(&preview, context).await?;
        }
        let skill = load_review_skill(context, skill_key).await?;
        if !is_compatible_review_skill(&skill.dir_name) {
            return Err(capability_changed_error());
        }
        let guidance = bounded_selected_guidance(&skill.content)?;
        verify_selected_review_skill_fingerprint(
            context,
            key,
            &skill,
            remote_user_source.as_ref(),
            fingerprint,
        )
        .await?;
        let guidance = if let Some(info) = remote_user_source {
            if info.path != skill.path {
                format!(
                    "Skill resources are relative to '{}'. Use that package root for scripts, references and templates; project operations still use the remote workspace.\n\n{guidance}",
                    skill.path,
                )
            } else if !skill.compatibility_warnings.is_empty() {
                format!("{}\n\n{guidance}", skill.compatibility_warnings.join("\n"))
            } else {
                guidance
            }
        } else {
            guidance
        };
        return Ok(ResolvedReviewCapability {
            guidance,
            preferred_model: None,
        });
    }
    if let Some(agent_key) = key.strip_prefix("agent:") {
        let agent = get_agent_registry()
            .get_subagents_for_query(&SubagentQueryContext {
                parent_agent_type: context.agent_type.as_deref(),
                workspace_id: (!context.is_remote())
                    .then(|| context.workspace_id())
                    .flatten(),
                list_scope: SubagentListScope::TaskVisible,
                include_disabled: false,
                external_sources_supported: false,
            })
            .await
            .into_iter()
            .find(|agent| agent.key == agent_key)
            .ok_or_else(|| {
                OpenBitFunError::tool("Review agent is no longer available".to_string())
            })?;
        let workspace_root = (!context.is_remote())
            .then(|| context.workspace_id())
            .flatten();
        let detail = get_agent_registry()
            .get_custom_subagent_detail_by_key(&agent.key, workspace_root)
            .await?;
        if !detail.readonly || !detail.review {
            return Err(OpenBitFunError::tool(
                "Selected review agent is not read-only review guidance".to_string(),
            ));
        }
        let guidance = bounded_selected_guidance(&detail.prompt)?;
        let preferred_model = explicit_preferred_model(&agent);
        ensure_capability_fingerprint(
            &ReviewCapabilityDescriptor::new(
                key,
                &detail.name,
                &detail.description,
                &agent_fingerprint_material(&guidance, preferred_model.as_deref()),
            ),
            fingerprint,
        )?;
        return Ok(ResolvedReviewCapability {
            guidance,
            preferred_model,
        });
    }

    Err(OpenBitFunError::tool(
        "Unknown review capability source".to_string(),
    ))
}

fn verify_review_skill_fingerprint(
    key: &str,
    skill: &SkillData,
    fingerprint: &str,
) -> OpenBitFunResult<()> {
    let guidance = bounded_selected_guidance(&skill.content)?;
    ensure_capability_fingerprint(
        &ReviewCapabilityDescriptor::new(key, &skill.name, &skill.description, &guidance),
        fingerprint,
    )
}

async fn verify_selected_review_skill_fingerprint(
    context: &ToolUseContext,
    key: &str,
    skill: &SkillData,
    source: Option<&SkillInfo>,
    fingerprint: &str,
) -> OpenBitFunResult<()> {
    if let Some(info) = source.filter(|info| info.path != skill.path) {
        // The admitted catalog fingerprints source guidance. Verify the raw
        // deployed snapshot before comparing its path-mapped instructions;
        // rereading the local source here would race the completed upload.
        let markdown = read_remote_review_skill_markdown(context, &skill.path, info).await?;
        let deployed_preview = parse_review_skill_preview(info, &markdown)?;
        verify_review_skill_fingerprint(key, &deployed_preview, fingerprint)
    } else {
        verify_review_skill_fingerprint(key, skill, fingerprint)
    }
}

fn explicit_preferred_model(agent: &AgentInfo) -> Option<String> {
    agent
        .model
        .clone()
        .filter(|_| agent.model_is_explicit == Some(true))
}

fn agent_fingerprint_material(guidance: &str, preferred_model: Option<&str>) -> String {
    format!(
        "{guidance}\0preferred_model={}",
        preferred_model.unwrap_or("<inherit>")
    )
}

async fn load_review_skill(
    context: &ToolUseContext,
    skill_key: &str,
) -> OpenBitFunResult<SkillData> {
    let still_implicitly_invocable = implicitly_invocable_skills(context)
        .await
        .into_iter()
        .any(|skill| skill.key == skill_key);
    if !still_implicitly_invocable {
        return Err(capability_changed_error());
    }

    let registry = get_skill_registry();
    if context.is_remote() {
        let fs = context.ws_fs().ok_or_else(|| {
            OpenBitFunError::tool("Remote review skill loading is unavailable".to_string())
        })?;
        let root = context
            .workspace
            .as_ref()
            .map(|workspace| workspace.root_path_string())
            .unwrap_or_default();
        registry
            .find_and_load_skill_by_key_for_remote_workspace_with_progress(
                skill_key,
                fs,
                &root,
                context.agent_type.as_deref(),
                Some(crate::agentic::tools::implementations::skills::remote_skill_progress::skill_load_progress(context, "AgentSpawn")),
            )
            .await
    } else {
        registry
            .find_and_load_skill_by_key_for_workspace(
                skill_key,
                context.workspace.as_ref(),
                context.agent_type.as_deref(),
            )
            .await
    }
}

async fn load_discovered_review_skill(
    context: &ToolUseContext,
    info: &SkillInfo,
) -> OpenBitFunResult<SkillData> {
    let entry_file = info.entry_file.as_deref().unwrap_or("SKILL.md");
    // Catalog construction previews guidance; deployment happens only when a
    // capability is selected through the registry above.
    let markdown = if context.is_remote() && info.level == SkillLocation::Project {
        read_remote_review_skill_markdown(context, &info.path, info).await?
    } else {
        tokio::fs::read_to_string(std::path::Path::new(&info.path).join(entry_file))
            .await
            .map_err(|error| {
                OpenBitFunError::tool(format!("Failed to read review skill: {error}"))
            })?
    };
    parse_review_skill_preview(info, &markdown)
}

async fn read_remote_review_skill_markdown(
    context: &ToolUseContext,
    path: &str,
    info: &SkillInfo,
) -> OpenBitFunResult<String> {
    let entry_file = info.entry_file.as_deref().unwrap_or("SKILL.md");
    let skill_file = format!("{}/{}", path.trim_end_matches('/'), entry_file);
    context
        .ws_fs()
        .ok_or_else(|| {
            OpenBitFunError::tool("Remote review skill loading is unavailable".to_string())
        })?
        .read_file_text(&skill_file)
        .await
        .map_err(|error| OpenBitFunError::tool(format!("Failed to read review skill: {error}")))
}

fn parse_review_skill_preview(info: &SkillInfo, markdown: &str) -> OpenBitFunResult<SkillData> {
    let mut data = SkillData::from_markdown_for_source_slot(
        info.parser_path(),
        markdown,
        info.level,
        true,
        info.parser_source_slot(),
    )
    .map_err(|error| OpenBitFunError::tool(error.to_string()))?;
    data.key = info.key.clone();
    data.source_slot = info.source_slot.clone();
    data.dir_name = info.dir_name.clone();
    Ok(data)
}

fn catalog_source_limits(skill_count: usize, agent_count: usize) -> (usize, usize) {
    let remaining = CAPABILITY_CATALOG_LIMIT.saturating_sub(1);
    let mut skill_limit = skill_count.min(remaining.div_ceil(2));
    let agent_limit = agent_count.min(remaining.saturating_sub(skill_limit));
    skill_limit = skill_count.min(remaining.saturating_sub(agent_limit));
    (skill_limit, agent_limit)
}

fn ensure_capability_fingerprint(
    descriptor: &ReviewCapabilityDescriptor,
    fingerprint: &str,
) -> OpenBitFunResult<()> {
    if descriptor.fingerprint == fingerprint {
        Ok(())
    } else {
        Err(capability_changed_error())
    }
}

fn capability_changed_error() -> OpenBitFunError {
    OpenBitFunError::tool(
        "The selected review capability is unavailable or changed; continue with the primary review instead"
            .to_string(),
    )
}

pub fn render_review_capability_catalog(descriptors: &[ReviewCapabilityDescriptor]) -> String {
    let entries = descriptors
        .iter()
        .map(|descriptor| {
            format!(
                "  <capability key=\"{}\" fingerprint=\"{}\" title=\"{}\">{}</capability>",
                xml_escape(&descriptor.key),
                xml_escape(&descriptor.fingerprint),
                xml_escape(&descriptor.title),
                xml_escape(&descriptor.description)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!("<review_capabilities>\n{entries}\n</review_capabilities>")
}

fn is_compatible_review_skill(dir_name: &str) -> bool {
    dir_name.starts_with("code-review-") && dir_name.len() > "code-review-".len()
}

fn bounded_selected_guidance(guidance: &str) -> OpenBitFunResult<String> {
    let guidance = guidance.trim();
    if guidance.is_empty() || guidance.chars().count() > SELECTED_GUIDANCE_LIMIT {
        return Err(OpenBitFunError::tool(
            "Selected review guidance is empty or exceeds the focused-check context limit"
                .to_string(),
        ));
    }
    Ok(guidance.to_string())
}

fn truncate_chars(value: &str, limit: usize) -> String {
    let was_truncated = value.chars().count() > limit;
    let mut value = value.chars().take(limit).collect::<String>();
    if was_truncated {
        value.push('…');
    }
    value
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agentic::tools::framework::ToolUseContext;
    use crate::agentic::tools::implementations::skills::registry::imports::{
        import_copy_as, remove_imported_copy,
    };
    use crate::agentic::WorkspaceBinding;
    use std::collections::HashMap;
    use std::path::PathBuf;

    fn local_tool_context(root: PathBuf) -> ToolUseContext {
        ToolUseContext {
            tool_call_id: None,
            agent_type: None,
            session_id: None,
            dialog_turn_id: None,
            workspace: Some(WorkspaceBinding::new(None, root)),
            loaded_deferred_tool_specs: Vec::new(),
            primary_model_facts: tool_runtime::context::PrimaryModelFacts::default(),
            custom_data: HashMap::new(),
            computer_use_host: None,
            runtime_tool_restrictions: Default::default(),
            runtime_handles: openbitfun_runtime_ports::ToolRuntimeHandles::default(),
        }
    }

    async fn import_review_skill(root: &std::path::Path, source_key: &str) -> SkillInfo {
        let registry = get_skill_registry();
        let source = registry
            .find_skill_by_key_for_workspace(source_key, Some(root))
            .await
            .expect("discovered review skill");
        import_copy_as(source, root.join(".openbitfun/skills"), None)
            .await
            .expect("imported review skill");
        registry
            .get_all_skills_for_workspace(Some(root))
            .await
            .into_iter()
            .find(|skill| {
                skill.is_native()
                    && skill
                        .import_origin
                        .as_ref()
                        .is_some_and(|origin| origin.source_key == source_key)
            })
            .expect("native review skill")
    }

    #[test]
    fn compatible_skill_uses_directory_convention_not_metadata_name() {
        assert!(is_compatible_review_skill("code-review-breaking-changes"));
        assert!(!is_compatible_review_skill("code-review"));
        assert!(!is_compatible_review_skill("frontend-design"));
    }

    #[test]
    fn capability_fingerprint_changes_with_selected_guidance() {
        let first = ReviewCapabilityDescriptor::new(
            "skill:project::code-review-testing",
            "Testing",
            "Check test coverage",
            "first body",
        );
        let second = ReviewCapabilityDescriptor::new(
            "skill:project::code-review-testing",
            "Testing",
            "Check test coverage",
            "changed body",
        );

        assert_ne!(first.fingerprint(), second.fingerprint());
        assert!(ensure_capability_fingerprint(&first, first.fingerprint()).is_ok());
        assert!(ensure_capability_fingerprint(&second, first.fingerprint()).is_err());
    }

    #[test]
    fn capability_fingerprint_changes_with_effective_model_preference() {
        let inherited = ReviewCapabilityDescriptor::new(
            "agent:project::openbitfun::reviewer",
            "Reviewer",
            "Check one concern",
            &agent_fingerprint_material("same guidance", None),
        );
        let explicit = ReviewCapabilityDescriptor::new(
            "agent:project::openbitfun::reviewer",
            "Reviewer",
            "Check one concern",
            &agent_fingerprint_material("same guidance", Some("fast")),
        );

        assert_ne!(inherited.fingerprint(), explicit.fingerprint());
    }

    #[test]
    fn catalog_limits_always_reserve_the_builtin_and_balance_sources() {
        let (skill_limit, agent_limit) = catalog_source_limits(24, 24);
        assert_eq!(1 + skill_limit + agent_limit, CAPABILITY_CATALOG_LIMIT);
        assert!(skill_limit > 0);
        assert!(agent_limit > 0);

        let (skill_limit, agent_limit) = catalog_source_limits(0, 24);
        assert_eq!(skill_limit, 0);
        assert_eq!(1 + agent_limit, CAPABILITY_CATALOG_LIMIT);
    }

    #[test]
    fn catalog_projection_is_bounded_and_does_not_include_full_guidance() {
        let descriptor = ReviewCapabilityDescriptor::new(
            "skill::project::custom::code-review-testing",
            "Testing",
            &"short description ".repeat(30),
            "full guidance that must not enter the catalog",
        );
        let rendered = render_review_capability_catalog(&[descriptor]);

        assert!(rendered.contains("Testing"));
        assert!(rendered.len() < 800);
        assert!(!rendered.contains("full guidance"));
    }

    #[tokio::test]
    async fn remote_catalog_previews_local_user_markdown_without_remote_io_or_deployment() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(
            temp.path().join("custom-entry.md"),
            "---\nname: review-local\ndescription: User guidance\n---\nCheck scripts/check.py.\n",
        )
        .unwrap();
        let info: SkillInfo = serde_json::from_value(serde_json::json!({
            "key": "user::openbitfun-user::code-review-local",
            "name": "review-local",
            "description": "User guidance",
            "path": temp.path().to_str().unwrap(),
            "entryFile": "custom-entry.md",
            "level": "user",
            "sourceSlot": "openbitfun-user",
            "dirName": "code-review-local"
        }))
        .unwrap();
        let identity = crate::service::remote_ssh::workspace_state::workspace_session_identity(
            "/remote/project",
            Some("catalog-test-connection"),
            Some("catalog-test-host"),
        )
        .unwrap();
        let mut context = local_tool_context(temp.path().to_path_buf());
        context.workspace = Some(WorkspaceBinding::new_remote(
            None,
            "/remote/project".into(),
            "catalog-test-connection".into(),
            "Remote".into(),
            identity,
        ));
        assert!(context.ws_fs().is_none());
        let data = load_discovered_review_skill(&context, &info).await.unwrap();
        assert_eq!(data.content.trim(), "Check scripts/check.py.");
        assert_eq!(data.key, info.key);
        let mut project = info;
        project.level = SkillLocation::Project;
        assert!(load_discovered_review_skill(&context, &project)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn deployed_review_guidance_verifies_raw_snapshot_before_path_mapping() {
        let temp = tempfile::tempdir().unwrap();
        let source_dir = temp.path().join("source");
        let remote_dir = temp.path().join("remote");
        std::fs::create_dir(&source_dir).unwrap();
        std::fs::create_dir(&remote_dir).unwrap();
        let source_path = source_dir.to_string_lossy().to_string();
        let remote_path = remote_dir.to_string_lossy().to_string();
        let info: SkillInfo = serde_json::from_value(serde_json::json!({
            "key": "user::openbitfun-user::code-review-local",
            "name": "review-local",
            "description": "User guidance",
            "path": source_path,
            "level": "user",
            "sourceSlot": "openbitfun-user",
            "dirName": "code-review-local"
        }))
        .unwrap();
        let markdown = format!(
            "---\nname: review-local\ndescription: User guidance\n---\nRead {}/references/guide.md.\n",
            info.path
        );
        std::fs::write(source_dir.join("SKILL.md"), &markdown).unwrap();
        std::fs::write(remote_dir.join("SKILL.md"), &markdown).unwrap();
        let preview = parse_review_skill_preview(&info, &markdown).unwrap();
        let key = format!("skill:{}", info.key);
        let descriptor = ReviewCapabilityDescriptor::new(
            &key,
            &preview.name,
            &preview.description,
            &bounded_selected_guidance(&preview.content).unwrap(),
        );
        let mut loaded = preview;
        loaded.content = loaded.content.replace(&info.path, &remote_path);
        loaded.path = remote_path.clone();
        assert!(verify_review_skill_fingerprint(&key, &loaded, descriptor.fingerprint()).is_err());

        let mut context = local_tool_context(temp.path().to_path_buf());
        context.runtime_handles = openbitfun_runtime_ports::ToolRuntimeHandles::new(
            Some(crate::agentic::workspace::local_workspace_services(
                remote_path,
            )),
            None,
        );
        // A later local edit does not change the snapshot already deployed.
        std::fs::write(source_dir.join("SKILL.md"), "changed local source").unwrap();
        verify_selected_review_skill_fingerprint(
            &context,
            &key,
            &loaded,
            Some(&info),
            descriptor.fingerprint(),
        )
        .await
        .unwrap();
        std::fs::write(
            remote_dir.join("SKILL.md"),
            markdown.replace("Read ", "Execute "),
        )
        .unwrap();
        assert!(verify_selected_review_skill_fingerprint(
            &context,
            &key,
            &loaded,
            Some(&info),
            descriptor.fingerprint(),
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn catalog_uses_discovered_claude_skill_and_restores_it_after_import_undo() {
        let temp = tempfile::tempdir().expect("temporary workspace");
        let skill_dir = temp
            .path()
            .join(".claude")
            .join("skills")
            .join("code-review-claude");
        std::fs::create_dir_all(&skill_dir).expect("skill directory");
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\narguments: target\n---\nReview $target for Claude compatibility.\n",
        )
        .expect("skill markdown");
        let context = local_tool_context(temp.path().to_path_buf());
        let source_key = "project::claude::code-review-claude";
        let source_descriptor = review_capability_catalog(&context)
            .await
            .into_iter()
            .find(|descriptor| descriptor.key() == format!("skill:{source_key}"))
            .expect("discovered Claude review skill descriptor");
        let source_guidance = resolve_review_capability(
            &context,
            source_descriptor.key(),
            source_descriptor.fingerprint(),
        )
        .await
        .expect("resolved discovered Claude guidance");
        assert_eq!(
            source_guidance.guidance,
            "Review $target for Claude compatibility."
        );
        assert!(!temp.path().join(".openbitfun/skills").exists());
        let imported = import_review_skill(temp.path(), source_key).await;

        let descriptor = review_capability_catalog(&context)
            .await
            .into_iter()
            .find(|descriptor| descriptor.key() == format!("skill:{}", imported.key))
            .expect("imported review skill descriptor");

        let resolved =
            resolve_review_capability(&context, descriptor.key(), descriptor.fingerprint())
                .await
                .expect("resolved imported Claude guidance");
        assert_eq!(
            resolved.guidance,
            "Review $target for Claude compatibility."
        );
        assert!(load_review_skill(&context, source_key).await.is_err());

        remove_imported_copy(
            std::path::Path::new(&imported.path),
            &imported.import_origin.as_ref().unwrap().import_id,
        )
        .await
        .expect("undo imported review skill");
        assert!(review_capability_catalog(&context)
            .await
            .iter()
            .all(|candidate| candidate.key() != descriptor.key()));
        assert!(
            resolve_review_capability(&context, descriptor.key(), descriptor.fingerprint())
                .await
                .is_err()
        );
        let restored_descriptor = review_capability_catalog(&context)
            .await
            .into_iter()
            .find(|candidate| candidate.key() == source_descriptor.key())
            .expect("source review skill restored after undo");
        assert_eq!(restored_descriptor, source_descriptor);
        assert_eq!(
            resolve_review_capability(
                &context,
                source_descriptor.key(),
                source_descriptor.fingerprint(),
            )
            .await
            .expect("source guidance remains available"),
            source_guidance
        );
        assert!(skill_dir.join("SKILL.md").is_file());
    }

    #[tokio::test]
    async fn resolve_rejects_discovered_skill_when_implicit_policy_changed_after_catalog() {
        assert_implicit_policy_change_revokes_review_skill(false).await;
    }

    #[tokio::test]
    async fn resolve_rejects_imported_skill_when_implicit_policy_changed_after_catalog() {
        assert_implicit_policy_change_revokes_review_skill(true).await;
    }

    async fn assert_implicit_policy_change_revokes_review_skill(import_copy: bool) {
        let temp = tempfile::tempdir().expect("temporary workspace");
        let skill_dir = temp
            .path()
            .join(".codex")
            .join("skills")
            .join("code-review-policy-change");
        std::fs::create_dir_all(skill_dir.join("agents")).expect("skill directories");
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: Policy review\ndescription: Check policy changes\n---\nReview policy-sensitive behavior.\n",
        )
        .expect("skill markdown");
        std::fs::write(
            skill_dir.join("agents").join("openai.yaml"),
            "policy:\n  allow_implicit_invocation: true\n",
        )
        .expect("initial policy");
        let context = local_tool_context(temp.path().to_path_buf());
        let effective_skill_dir = if import_copy {
            let imported =
                import_review_skill(temp.path(), "project::codex::code-review-policy-change").await;
            PathBuf::from(imported.path)
        } else {
            skill_dir
        };
        let descriptor = review_capability_catalog(&context)
            .await
            .into_iter()
            .find(|descriptor| descriptor.key().contains("code-review-policy-change"))
            .expect("review skill descriptor");
        assert!(
            resolve_review_capability(&context, descriptor.key(), descriptor.fingerprint())
                .await
                .is_ok()
        );

        std::fs::write(
            effective_skill_dir.join("agents").join("openai.yaml"),
            "policy:\n  allow_implicit_invocation: false\n",
        )
        .expect("updated policy");

        let result =
            resolve_review_capability(&context, descriptor.key(), descriptor.fingerprint()).await;
        assert!(result.is_err());
    }
}
