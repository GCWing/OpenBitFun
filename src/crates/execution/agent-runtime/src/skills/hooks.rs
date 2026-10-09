//! Executable skill declarations. Discovery validates the complete declaration;
//! only invocation publishes its handlers into a session's existing registry.

use super::SkillParseError;
use crate::native_hooks::{
    AgentHookEvent, AgentHookHandler, AgentHookMatcher, AgentHookScope, AgentHookSettings,
    AgentHookSettingsLayer,
};
use serde_json::{json, Value};

#[derive(Debug, Clone)]
// Discovery-only consumers validate and retain these fields without executing them.
#[cfg_attr(not(feature = "native-hook-runtime"), allow(dead_code))]
struct SkillHook {
    event: AgentHookEvent,
    matcher: AgentHookMatcher,
    handler: AgentHookHandler,
    once: bool,
}

#[derive(Debug, Clone)]
pub struct SkillHooks {
    hooks: Vec<SkillHook>,
    fingerprint: String,
}

impl SkillHooks {
    pub fn from_yaml(value: &serde_yaml::Value) -> Result<Self, SkillParseError> {
        let value = serde_json::to_value(value).map_err(|error| {
            SkillParseError::InvalidFormat(format!("Invalid skill hooks: {error}"))
        })?;
        let invalid = || {
            SkillParseError::InvalidFormat(
                "Skill hooks must contain valid event matcher groups and command handlers".into(),
            )
        };
        let events = value.as_object().ok_or_else(invalid)?;
        for (event, groups) in events {
            if AgentHookEvent::parse(event).is_none() {
                return Err(SkillParseError::UnsupportedClaudeField(format!(
                    "hooks.{event}"
                )));
            }
            for group in groups.as_array().ok_or_else(invalid)? {
                let group = group.as_object().ok_or_else(invalid)?;
                if let Some(field) = group
                    .keys()
                    .find(|field| !matches!(field.as_str(), "matcher" | "hooks"))
                {
                    return Err(SkillParseError::UnsupportedClaudeField(format!(
                        "hooks.{field}"
                    )));
                }
                for handler in group
                    .get("hooks")
                    .and_then(Value::as_array)
                    .ok_or_else(invalid)?
                {
                    let handler = handler.as_object().ok_or_else(invalid)?;
                    if let Some(kind) = handler.get("type").and_then(Value::as_str) {
                        if kind != "command" {
                            return Err(SkillParseError::UnsupportedClaudeField(format!(
                                "hooks.type={kind}"
                            )));
                        }
                    }
                    if let Some(field) = handler.keys().find(|field| {
                        !matches!(
                            field.as_str(),
                            "type"
                                | "command"
                                | "commandWindows"
                                | "timeout"
                                | "statusMessage"
                                | "once"
                        )
                    }) {
                        return Err(SkillParseError::UnsupportedClaudeField(format!(
                            "hooks.{field}"
                        )));
                    }
                    if handler.get("once").is_some_and(|once| !once.is_boolean()) {
                        return Err(invalid());
                    }
                }
            }
        }
        let (settings, issues) = AgentHookSettings::from_layers(&[AgentHookSettingsLayer {
            scope: AgentHookScope::User,
            source: "skill hooks".into(),
            bytes: serde_json::to_vec(&json!({ "hooks": value })).map_err(|_| invalid())?,
        }]);
        // Unlike optional user configuration, dropping any skill declaration
        // would silently remove part of that skill's behavior or constraints.
        if !issues.is_empty() {
            return Err(SkillParseError::InvalidFormat(
                issues
                    .iter()
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
                    .join("; "),
            ));
        }
        let mut hooks = Vec::new();
        for event in AgentHookEvent::ALL {
            let Some(groups) = events.get(event.as_str()).and_then(Value::as_array) else {
                continue;
            };
            let mut rules = settings.rules_for(event).iter();
            for group in groups {
                let raw_handlers = group["hooks"].as_array().ok_or_else(invalid)?;
                if raw_handlers.is_empty() {
                    continue;
                }
                let rule = rules.next().ok_or_else(invalid)?;
                for (handler, raw) in rule.handlers.iter().zip(raw_handlers) {
                    hooks.push(SkillHook {
                        event,
                        matcher: rule.matcher.clone(),
                        handler: handler.clone(),
                        once: raw.get("once").and_then(Value::as_bool).unwrap_or(false),
                    });
                }
            }
        }
        Ok(Self {
            hooks,
            fingerprint: value.to_string(),
        })
    }

    pub fn is_empty(&self) -> bool {
        self.hooks.is_empty()
    }

    pub fn fingerprint(&self) -> &str {
        &self.fingerprint
    }

    #[cfg(feature = "native-hook-runtime")]
    pub fn registrations(
        &self,
        session_id: &str,
        skill_key: &str,
        skill_path: &str,
        workspace_scope: Option<&str>,
        workspace_root: &str,
    ) -> Vec<crate::native_hooks::RuntimeHookRegistration> {
        use crate::native_hooks::{
            CommandHookOptions, HookToolMapping, RuntimeHookKind, RuntimeHookRegistration,
            RuntimeHookSource,
        };
        self.hooks
            .iter()
            .enumerate()
            .map(|(index, hook)| {
                let id = json!(["skill", session_id, skill_key, index]).to_string();
                let mut registration = RuntimeHookRegistration::command(
                    id,
                    RuntimeHookKind::Lifecycle(hook.event),
                    RuntimeHookSource::SkillCommand,
                    hook.handler.clone(),
                    hook.matcher.clone(),
                )
                .with_command_options(CommandHookOptions {
                    environment: [
                        ("CLAUDE_SESSION_ID".into(), session_id.into()),
                        ("CLAUDE_SKILL_DIR".into(), skill_path.into()),
                        ("CLAUDE_PROJECT_DIR".into(), workspace_root.into()),
                    ]
                    .into(),
                    // The Skill parser already owns Claude dialect projection.
                    // Keep the engine's mapping primitive provider-neutral.
                    tool_mappings: vec![
                        HookToolMapping {
                            runtime_name: "ExecCommand".into(),
                            hook_name: "Bash".into(),
                            input_fields: [("cmd".into(), "command".into())].into(),
                            input_adapter: None,
                        },
                        HookToolMapping {
                            runtime_name: "Write".into(),
                            hook_name: "Write".into(),
                            input_fields: Default::default(),
                            input_adapter: Some(std::sync::Arc::new(ClaudeWriteInput)),
                        },
                    ],
                    supports_ask: true,
                    once: hook.once.then(|| tokio::sync::Mutex::new(false)),
                });
                registration.plan = registration.plan.with_order(index as u16);
                if let Some(workspace) = workspace_scope {
                    registration = registration.with_workspace_scope(workspace);
                }
                registration
            })
            .collect()
    }
}

#[cfg(feature = "native-hook-runtime")]
#[derive(Debug)]
struct ClaudeWriteInput;

#[cfg(feature = "native-hook-runtime")]
impl crate::native_hooks::HookInputAdapter for ClaudeWriteInput {
    fn to_hook(&self, input: &mut Value) -> Result<(), String> {
        let payload = input
            .get("payload")
            .and_then(Value::as_str)
            .ok_or("Cannot inspect Write with skill hooks: missing path-first payload")?;
        let (header, content) = payload.split_once('\n').unwrap_or((payload, ""));
        let path = header
            .trim_end_matches('\r')
            .strip_prefix("+++ ")
            .filter(|path| !path.trim().is_empty())
            .ok_or("Cannot inspect Write with skill hooks: an explicit destination is required")?;
        let path = path.to_owned();
        let content = content.to_owned();
        let fields = input
            .as_object_mut()
            .ok_or("Write input must be an object")?;
        fields.remove("payload");
        fields.insert("file_path".into(), Value::String(path));
        fields.insert("content".into(), Value::String(content));
        Ok(())
    }

    fn to_runtime(&self, input: &mut Value) -> Result<(), String> {
        let path = input
            .get("file_path")
            .and_then(Value::as_str)
            .filter(|path| !path.trim().is_empty() && !path.contains(['\n', '\r']))
            .ok_or("Invalid Write hook updatedInput: file_path is required")?;
        let content = input
            .get("content")
            .and_then(Value::as_str)
            .ok_or("Invalid Write hook updatedInput: content is required")?;
        let payload = format!("+++ {path}\n{content}");
        let fields = input
            .as_object_mut()
            .ok_or("Write input must be an object")?;
        fields.remove("file_path");
        fields.remove("content");
        fields.insert("payload".into(), Value::String(payload));
        Ok(())
    }
}
