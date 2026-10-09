//! Skill invocation only activates validated commands in the owning session.

use super::{hooks_config, runtime_hook_registry, AgentHooksConfig};
use crate::agentic::tools::framework::ToolUseContext;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use openbitfun_agent_runtime::native_hooks::RuntimeHookRegistry;
use openbitfun_agent_runtime::skills::{SkillData, SkillLocation};

pub(crate) async fn activate_skill_hooks(
    skill: &SkillData,
    context: &ToolUseContext,
) -> OpenBitFunResult<()> {
    activate(
        &runtime_hook_registry(),
        &hooks_config().await,
        skill,
        context,
    )
}

fn activate(
    registry: &RuntimeHookRegistry,
    config: &AgentHooksConfig,
    skill: &SkillData,
    context: &ToolUseContext,
) -> OpenBitFunResult<()> {
    let Some(hooks) = skill.hooks.as_ref().filter(|hooks| !hooks.is_empty()) else {
        return Ok(());
    };
    let reject = |reason: &str| {
        OpenBitFunError::tool(format!(
            "Cannot activate skill '{}' hooks: {reason}",
            skill.name
        ))
    };
    if context.is_remote() {
        return Err(reject(
            "command hooks are unsupported in remote workspaces; no local command was executed",
        ));
    }
    if !config.enabled {
        return Err(reject("app.hooks.enabled is disabled"));
    }
    if skill.location == SkillLocation::Project && !config.project_hooks_enabled {
        return Err(reject(
            "project skill commands require app.hooks.project_hooks_enabled",
        ));
    }
    let session_id = context
        .session_id
        .as_deref()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| reject("an owning session is required"))?;
    let root = context
        .workspace_root()
        .ok_or_else(|| reject("an owning local workspace is required"))?;
    let root = root.to_string_lossy();
    let skill_path = skill.path.as_str();
    let fingerprint = serde_json::json!([
        hooks.fingerprint(),
        skill_path,
        context.workspace_id(),
        root
    ])
    .to_string();
    let mut registrations = hooks.registrations(
        session_id,
        &skill.key,
        skill_path,
        context.workspace_id(),
        &root,
    );
    for registration in &mut registrations {
        registration.requires_project_trust = skill.location == SkillLocation::Project;
    }
    registry
        .register_session_skill(session_id, &skill.key, &fingerprint, registrations)
        .map_err(|error| reject(&error.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agentic::workspace::WorkspaceBinding;
    use openbitfun_agent_runtime::native_hooks::{AgentHookEngine, AgentHookEvent};

    fn guarded_skill() -> SkillData {
        let mut skill = SkillData::from_markdown_for_source_slot("/skills/guard".into(),
            "---\nname: guard\ndescription: Guard tools\nhooks:\n  PreToolUse:\n    - matcher: Edit\n      hooks:\n        - type: command\n          command: exit 2\n---\nGuard edits.\n", SkillLocation::User, true, "claude").unwrap();
        skill.key = "user::claude::guard".into();
        skill
    }

    #[test]
    fn activation_gates_and_idempotence_are_session_owned() {
        let root = tempfile::tempdir().unwrap();
        let registry = RuntimeHookRegistry::default();
        let engine = AgentHookEngine::with_registry(registry.clone());
        let mut context = ToolUseContext::for_tool_listing(
            Some(WorkspaceBinding::new(Some("w".into()), root.path().into())),
            None,
        );
        let mut skill = guarded_skill();
        assert!(
            activate(&registry, &AgentHooksConfig::default(), &skill, &context)
                .unwrap_err()
                .to_string()
                .contains("session")
        );
        context.session_id = Some("skill-session".into());
        assert!(!engine.has_rules_for_session(
            AgentHookEvent::PreToolUse,
            Some("w"),
            "skill-session"
        ));
        let mut config = AgentHooksConfig::default();
        config.enabled = false;
        assert!(activate(&registry, &config, &skill, &context).is_err());
        config.enabled = true;
        skill.location = SkillLocation::Project;
        assert!(activate(&registry, &config, &skill, &context).is_err());
        config.project_hooks_enabled = true;
        activate(&registry, &config, &skill, &context).unwrap();
        activate(&registry, &config, &skill, &context).unwrap();
        assert!(engine.has_rules_for_session(
            AgentHookEvent::PreToolUse,
            Some("w"),
            "skill-session"
        ));
        assert!(!engine.has_rules_for_session(
            AgentHookEvent::PreToolUse,
            Some("w"),
            "other-session"
        ));
        registry.clear_session("skill-session");
        assert!(!engine.has_rules_for_session(
            AgentHookEvent::PreToolUse,
            Some("w"),
            "skill-session"
        ));
        let identity = crate::service::remote_ssh::workspace_state::workspace_session_identity(
            "/remote/project",
            Some("connection"),
            Some("host"),
        )
        .unwrap();
        context.workspace = Some(WorkspaceBinding::new_remote(
            None,
            "/remote/project".into(),
            "connection".into(),
            "Remote".into(),
            identity,
        ));
        assert!(activate(&registry, &config, &skill, &context)
            .unwrap_err()
            .to_string()
            .contains("remote workspaces"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn session_end_runs_registered_hooks_then_clears_state() {
        let temp = tempfile::tempdir().unwrap();
        let session = uuid::Uuid::new_v4().to_string();
        let hooks = openbitfun_agent_runtime::skills::SkillHooks::from_yaml(
            &serde_yaml::from_str(
                "SessionEnd: [{hooks: [{type: command, command: 'touch ended'}]}]",
            )
            .unwrap(),
        )
        .unwrap();
        let registry = runtime_hook_registry();
        registry
            .register_session_skill(
                &session,
                "end",
                hooks.fingerprint(),
                hooks.registrations(&session, "end", "/", None, "/"),
            )
            .unwrap();
        super::super::dispatch_session_end(
            super::super::NativeHookSessionFacts {
                workspace_id: None,
                session_id: &session,
                turn_id: None,
                workspace_root: Some(temp.path()),
                is_remote_workspace: false,
                model: "test",
                bypass_permissions: false,
            },
            "other",
        )
        .await;
        assert!(temp.path().join("ended").exists());
        assert!(
            !AgentHookEngine::with_registry(registry).has_rules_for_session(
                AgentHookEvent::SessionEnd,
                None,
                &session
            )
        );
    }
}
