use openbitfun_agent_tools::{ToolContextFacts, ToolRuntimeRestrictions, ToolWorkspaceKind};
use openbitfun_runtime_ports::DelegationPolicy;
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrimaryModelFacts {
    pub model_id: String,
    pub model_name: String,
    pub api_format: String,
    pub supports_image_inputs: bool,
}

impl PrimaryModelFacts {
    pub fn new(
        model_id: impl Into<String>,
        model_name: impl Into<String>,
        api_format: impl Into<String>,
        supports_image_inputs: bool,
    ) -> Self {
        Self {
            model_id: model_id.into(),
            model_name: model_name.into(),
            api_format: api_format.into(),
            supports_image_inputs,
        }
    }

    pub fn multimodal_tool_output_supported(&self) -> bool {
        matches!(
            self.api_format.to_lowercase().as_str(),
            "anthropic" | "openai" | "response" | "responses" | "gemini"
        )
    }
}

impl Default for PrimaryModelFacts {
    fn default() -> Self {
        Self {
            model_id: String::new(),
            model_name: String::new(),
            api_format: String::new(),
            // Preserve the historical behavior for listing/API contexts that do
            // not carry model metadata.
            supports_image_inputs: true,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ToolRuntimeCustomDataInput<'a> {
    pub context_vars: &'a HashMap<String, String>,
    pub delegation_policy: DelegationPolicy,
    pub remote_file_delivery_key: &'a str,
    pub extension_custom_data: Option<&'a HashMap<String, Value>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolRuntimeContextFactsInput {
    pub tool_call_id: Option<String>,
    pub agent_type: Option<String>,
    pub session_id: Option<String>,
    pub dialog_turn_id: Option<String>,
    pub workspace_kind: Option<ToolWorkspaceKind>,
    pub workspace_root: Option<String>,
    pub runtime_tool_restrictions: ToolRuntimeRestrictions,
}

pub fn build_tool_runtime_custom_data(
    input: ToolRuntimeCustomDataInput<'_>,
) -> HashMap<String, Value> {
    let mut map = HashMap::new();

    map.insert(
        "delegation_allow_subagent_spawn".to_string(),
        serde_json::json!(input.delegation_policy.allow_subagent_spawn),
    );
    map.insert(
        "delegation_nesting_depth".to_string(),
        serde_json::json!(input.delegation_policy.nesting_depth),
    );
    map.insert(
        "delegation_scope".to_string(),
        serde_json::json!(input.delegation_policy.scope),
    );

    insert_u64_context_var(input.context_vars, &mut map, "turn_index");
    insert_bool_context_var(input.context_vars, &mut map, "acp_transport");
    insert_bool_context_var(input.context_vars, &mut map, input.remote_file_delivery_key);
    if let Some(extension_custom_data) = input.extension_custom_data {
        for (key, value) in extension_custom_data {
            map.entry(key.clone()).or_insert_with(|| value.clone());
        }
    }

    map
}

pub fn project_tool_context_facts(input: ToolRuntimeContextFactsInput) -> ToolContextFacts {
    ToolContextFacts {
        tool_call_id: input.tool_call_id,
        agent_type: input.agent_type,
        session_id: input.session_id,
        dialog_turn_id: input.dialog_turn_id,
        workspace_kind: input.workspace_kind,
        workspace_root: input.workspace_root,
        runtime_tool_restrictions: input.runtime_tool_restrictions,
    }
}

pub fn delegation_policy_from_custom_data(
    custom_data: &HashMap<String, Value>,
) -> DelegationPolicy {
    let allow_subagent_spawn = custom_data
        .get("delegation_allow_subagent_spawn")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let nesting_depth = custom_data
        .get("delegation_nesting_depth")
        .and_then(Value::as_u64)
        .and_then(|value| u8::try_from(value).ok())
        .unwrap_or(0);
    let scope = custom_data
        .get("delegation_scope")
        .and_then(|value| serde_json::from_value(value.clone()).ok())
        .unwrap_or_default();

    DelegationPolicy {
        allow_subagent_spawn,
        nesting_depth,
        scope,
    }
}

fn insert_u64_context_var(
    context_vars: &HashMap<String, String>,
    map: &mut HashMap<String, Value>,
    key: &str,
) {
    if let Some(value) = context_vars.get(key) {
        if let Ok(parsed) = value.parse::<u64>() {
            map.insert(key.to_string(), serde_json::json!(parsed));
        }
    }
}

fn insert_bool_context_var(
    context_vars: &HashMap<String, String>,
    map: &mut HashMap<String, Value>,
    key: &str,
) {
    if let Some(value) = context_vars.get(key) {
        if let Ok(parsed) = value.parse::<bool>() {
            map.insert(key.to_string(), serde_json::json!(parsed));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_tool_runtime_custom_data, delegation_policy_from_custom_data,
        project_tool_context_facts, PrimaryModelFacts, ToolRuntimeContextFactsInput,
        ToolRuntimeCustomDataInput,
    };
    use openbitfun_agent_tools::{ToolRuntimeRestrictions, ToolWorkspaceKind};
    use openbitfun_runtime_ports::{DelegationPolicy, DelegationScope};
    use serde_json::json;
    use std::collections::{BTreeSet, HashMap};

    #[test]
    fn materializes_provider_neutral_tool_custom_data() {
        let mut context_vars = HashMap::new();
        context_vars.insert("turn_index".to_string(), "7".to_string());
        context_vars.insert("acp_transport".to_string(), "true".to_string());
        context_vars.insert("remote_file_delivery".to_string(), "true".to_string());
        let extension_custom_data = HashMap::from([("extension_key".to_string(), json!("kept"))]);

        let custom_data = build_tool_runtime_custom_data(ToolRuntimeCustomDataInput {
            context_vars: &context_vars,
            delegation_policy: DelegationPolicy::top_level().spawn_child(),
            remote_file_delivery_key: "remote_file_delivery",
            extension_custom_data: Some(&extension_custom_data),
        });

        assert_eq!(custom_data["delegation_allow_subagent_spawn"], json!(false));
        assert_eq!(custom_data["delegation_nesting_depth"], json!(1));
        assert_eq!(custom_data["delegation_scope"], json!("standard"));
        assert_eq!(custom_data["turn_index"], json!(7));
        assert_eq!(custom_data["acp_transport"], json!(true));
        assert_eq!(custom_data["remote_file_delivery"], json!(true));
        assert_eq!(custom_data["extension_key"], json!("kept"));
    }

    #[test]
    fn custom_data_ignores_invalid_or_empty_context_values() {
        let mut context_vars = HashMap::new();
        context_vars.insert("turn_index".to_string(), "not-a-number".to_string());
        context_vars.insert("acp_transport".to_string(), "not-bool".to_string());
        context_vars.insert("remote_file_delivery".to_string(), "not-bool".to_string());

        let custom_data = build_tool_runtime_custom_data(ToolRuntimeCustomDataInput {
            context_vars: &context_vars,
            delegation_policy: DelegationPolicy::top_level(),
            remote_file_delivery_key: "remote_file_delivery",
            extension_custom_data: None,
        });

        assert_eq!(custom_data["delegation_allow_subagent_spawn"], json!(true));
        assert_eq!(custom_data["delegation_nesting_depth"], json!(0));
        assert!(!custom_data.contains_key("turn_index"));
        assert!(!custom_data.contains_key("acp_transport"));
        assert!(!custom_data.contains_key("remote_file_delivery"));
    }

    #[test]
    fn extension_custom_data_cannot_override_runtime_owned_values() {
        let mut context_vars = HashMap::new();
        context_vars.insert("turn_index".to_string(), "7".to_string());
        let extension_custom_data = HashMap::from([
            ("turn_index".to_string(), json!(99)),
            ("delegation_allow_subagent_spawn".to_string(), json!(false)),
            ("extension_key".to_string(), json!("kept")),
        ]);

        let custom_data = build_tool_runtime_custom_data(ToolRuntimeCustomDataInput {
            context_vars: &context_vars,
            delegation_policy: DelegationPolicy::top_level(),
            remote_file_delivery_key: "remote_file_delivery",
            extension_custom_data: Some(&extension_custom_data),
        });

        assert_eq!(custom_data["delegation_allow_subagent_spawn"], json!(true));
        assert_eq!(custom_data["turn_index"], json!(7));
        assert_eq!(custom_data["extension_key"], json!("kept"));
    }

    #[test]
    fn derives_runtime_policies_from_custom_data() {
        let mut custom_data = HashMap::new();
        custom_data.insert("delegation_allow_subagent_spawn".to_string(), json!(false));
        custom_data.insert("delegation_nesting_depth".to_string(), json!(3));
        assert_eq!(
            delegation_policy_from_custom_data(&custom_data),
            DelegationPolicy {
                allow_subagent_spawn: false,
                nesting_depth: 3,
                scope: DelegationScope::Standard,
            }
        );
        assert!(PrimaryModelFacts::default().supports_image_inputs);
    }

    #[test]
    fn multimodal_tool_output_matches_supported_wire_formats() {
        for format in [
            "anthropic",
            "openai",
            "response",
            "responses",
            "gemini",
            "Gemini",
        ] {
            assert!(
                PrimaryModelFacts::new("m", "m", format, true).multimodal_tool_output_supported()
            );
        }
        for format in ["", "unknown"] {
            assert!(
                !PrimaryModelFacts::new("m", "m", format, true).multimodal_tool_output_supported()
            );
        }
    }

    #[test]
    fn projects_prompt_safe_tool_context_facts_only() {
        let facts = project_tool_context_facts(ToolRuntimeContextFactsInput {
            tool_call_id: Some("tool-1".to_string()),
            agent_type: Some("coding".to_string()),
            session_id: Some("session-1".to_string()),
            dialog_turn_id: Some("turn-1".to_string()),
            workspace_kind: Some(ToolWorkspaceKind::Remote),
            workspace_root: Some("/home/user/project".to_string()),
            runtime_tool_restrictions: ToolRuntimeRestrictions {
                allowed_tool_names: BTreeSet::from(["Read".to_string()]),
                denied_tool_names: BTreeSet::from(["ExecCommand".to_string()]),
                denied_tool_messages: Default::default(),
                path_policy: Default::default(),
                miniapp_context_scope: None,
            },
        });

        let value = serde_json::to_value(&facts).expect("serialize facts");
        assert_eq!(value["toolCallId"], "tool-1");
        assert_eq!(value["agentType"], "coding");
        assert_eq!(value["sessionId"], "session-1");
        assert_eq!(value["dialogTurnId"], "turn-1");
        assert_eq!(value["workspaceKind"], "remote");
        assert_eq!(value["workspaceRoot"], "/home/user/project");
        assert_eq!(
            value["runtimeToolRestrictions"]["allowed_tool_names"][0],
            "Read"
        );
        assert!(value.get("customData").is_none());
        assert!(value.get("runtimeHandles").is_none());
        assert!(value.get("unlockedCollapsedTools").is_none());
    }
}
