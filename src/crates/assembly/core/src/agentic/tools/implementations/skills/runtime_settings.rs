//! Execution-host settings for product-owned built-in skill instructions.

use super::types::SkillData;
use crate::service::config::global::GlobalConfigManager;
use crate::service::config::types::AIExperienceConfig;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use openbitfun_agent_runtime::skills::OPENBITFUN_SYSTEM_SKILL_SLOT;

const COMMIT_SKILL_KEY: &str = "user::openbitfun-system::commit-push-pr";
const COMMIT_COAUTHOR_POLICY_PLACEHOLDER: &str = "{{OPENBITFUN_GIT_COMMIT_COAUTHOR_POLICY}}";

pub(super) async fn apply_builtin_runtime_settings(skill: &mut SkillData) -> OpenBitFunResult<()> {
    if skill.key != COMMIT_SKILL_KEY || skill.source_slot != OPENBITFUN_SYSTEM_SKILL_SLOT {
        return Ok(());
    }

    // The runtime owns this preference even when the workspace or controller is remote.
    // Configuration errors must not silently restore attribution after an opt-out.
    let config_service = GlobalConfigManager::get_service().await?;
    let settings: AIExperienceConfig = config_service.get_config(Some("app.ai_experience")).await?;
    skill.content =
        render_commit_coauthor_policy(&skill.content, settings.enable_git_commit_coauthor)?;
    Ok(())
}

fn render_commit_coauthor_policy(content: &str, enabled: bool) -> OpenBitFunResult<String> {
    if !content.contains(COMMIT_COAUTHOR_POLICY_PLACEHOLDER) {
        return Err(OpenBitFunError::tool(
            "Built-in commit skill is missing its runtime co-author setting".to_string(),
        ));
    }

    let policy = if enabled {
        "The execution host setting `app.ai_experience.enable_git_commit_coauthor` is `true`. Unless the user explicitly opts out, add the exact OpenBitFun co-author trailer below exactly once to each new commit."
    } else {
        "The execution host setting `app.ai_experience.enable_git_commit_coauthor` is `false`. Do not add the OpenBitFun co-author trailer to new commits. Preserve other co-authors and existing commit history."
    };
    Ok(content.replace(COMMIT_COAUTHOR_POLICY_PLACEHOLDER, policy))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agentic::tools::implementations::skills::types::{
        render_loaded_skill_for_assistant, SkillLocation,
    };

    const COMMIT_SKILL: &str =
        include_str!("../../../../../builtin_skills/commit-push-pr/SKILL.md");

    #[test]
    fn builtin_commit_coauthor_policy_resolves_both_preferences_for_the_assistant() {
        for enabled in [true, false] {
            let mut skill = SkillData::from_markdown(
                "/openbitfun-system/commit-push-pr".to_string(),
                COMMIT_SKILL,
                SkillLocation::User,
                true,
            )
            .unwrap();
            skill.content = render_commit_coauthor_policy(&skill.content, enabled).unwrap();
            let assistant = render_loaded_skill_for_assistant(&skill, false);
            assert!(!assistant.contains(COMMIT_COAUTHOR_POLICY_PLACEHOLDER));
            assert!(assistant.contains(&format!(
                "`app.ai_experience.enable_git_commit_coauthor` is `{enabled}`"
            )));
            if enabled {
                assert!(assistant
                    .contains("add the exact OpenBitFun co-author trailer below exactly once"));
            } else {
                assert!(assistant
                    .contains("Do not add the OpenBitFun co-author trailer to new commits"));
                assert!(!assistant
                    .contains("add the exact OpenBitFun co-author trailer below exactly once"));
            }
            assert!(assistant.contains("Generated with [OpenBitFun](https://github.com/bitfun-ai)"));
        }
    }

    #[tokio::test]
    async fn custom_commit_skills_do_not_receive_product_runtime_settings() {
        let mut skill = SkillData::from_markdown(
            "/workspace/.agents/skills/commit-push-pr".to_string(),
            COMMIT_SKILL,
            SkillLocation::Project,
            true,
        )
        .unwrap();
        let original = skill.content.clone();
        apply_builtin_runtime_settings(&mut skill).await.unwrap();
        assert_eq!(skill.content, original);
    }

    #[test]
    fn commit_coauthor_policy_rejects_an_unresolved_builtin_contract() {
        assert!(
            render_commit_coauthor_policy("Unresolved attribution instructions", false).is_err()
        );
    }
}
