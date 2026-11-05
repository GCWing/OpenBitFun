use agent_client_protocol::schema::{
    Cost, ModelInfo, SessionConfigKind, SessionConfigOption, SessionConfigOptionCategory,
    SessionConfigSelectOptions, SessionModelState,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpSessionContextUsage {
    pub used: u64,
    pub size: u64,
    #[serde(default)]
    pub cost: Option<Cost>,
}

impl From<agent_client_protocol::schema::UsageUpdate> for AcpSessionContextUsage {
    fn from(update: agent_client_protocol::schema::UsageUpdate) -> Self {
        Self {
            used: update.used,
            size: update.size,
            cost: update.cost,
        }
    }
}

/// A slash command advertised by an ACP agent via `AvailableCommandsUpdate`.
///
/// Invocation is plain prompt text: `/<name> <args>`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpAvailableCommand {
    pub name: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_hint: Option<String>,
}

impl From<agent_client_protocol::schema::AvailableCommand> for AcpAvailableCommand {
    fn from(command: agent_client_protocol::schema::AvailableCommand) -> Self {
        use agent_client_protocol::schema::AvailableCommandInput;

        let input_hint = command.input.and_then(|input| match input {
            AvailableCommandInput::Unstructured(unstructured) => Some(unstructured.hint),
            _ => None,
        });

        Self {
            name: command.name,
            description: command.description,
            input_hint,
        }
    }
}

/// One entry of an ACP agent execution plan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpPlanEntry {
    pub content: String,
    pub priority: String,
    pub status: String,
}

impl From<agent_client_protocol::schema::PlanEntry> for AcpPlanEntry {
    fn from(entry: agent_client_protocol::schema::PlanEntry) -> Self {
        use agent_client_protocol::schema::{PlanEntryPriority, PlanEntryStatus};

        let priority = match entry.priority {
            PlanEntryPriority::High => "high",
            PlanEntryPriority::Medium => "medium",
            PlanEntryPriority::Low => "low",
            _ => "medium",
        };
        let status = match entry.status {
            PlanEntryStatus::Pending => "pending",
            PlanEntryStatus::InProgress => "in_progress",
            PlanEntryStatus::Completed => "completed",
            _ => "pending",
        };

        Self {
            content: entry.content,
            priority: priority.to_string(),
            status: status.to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AcpSessionOptions {
    /// Present on combined metadata reads; absence preserves the legacy commands endpoint.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub available_commands: Option<Vec<AcpAvailableCommand>>,
    #[serde(default)]
    pub current_model_id: Option<String>,
    #[serde(default)]
    pub available_models: Vec<AcpSessionModelOption>,
    #[serde(default)]
    pub model_config_id: Option<String>,
    #[serde(default)]
    pub config_options: Vec<AcpSessionConfigOption>,
    #[serde(default)]
    pub context_usage: Option<AcpSessionContextUsage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpSessionModelOption {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpSessionConfigOption {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(flatten)]
    pub kind: AcpSessionConfigKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AcpSessionConfigKind {
    Select {
        current_value: String,
        options: Vec<AcpSessionConfigSelectOption>,
    },
    Boolean {
        current_value: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpSessionConfigSelectOption {
    pub value: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
}

pub(super) fn session_options_from_state(
    models: Option<&SessionModelState>,
    config_options: &[SessionConfigOption],
    context_usage: Option<&AcpSessionContextUsage>,
) -> AcpSessionOptions {
    let context_usage = context_usage.cloned();
    let session_config_options = config_options
        .iter()
        .filter_map(session_config_option_from_protocol)
        .collect();
    if let Some(models) = models.filter(|models| !models.available_models.is_empty()) {
        return AcpSessionOptions {
            current_model_id: Some(models.current_model_id.to_string()),
            available_models: models
                .available_models
                .iter()
                .map(model_option_from_model_info)
                .collect(),
            model_config_id: None,
            config_options: session_config_options,
            context_usage,
            ..Default::default()
        };
    }

    if let Some(option) = model_config_option(config_options) {
        let (current_model_id, available_models) = select_model_values(option);
        return AcpSessionOptions {
            current_model_id,
            available_models,
            model_config_id: Some(option.id.to_string()),
            config_options: session_config_options,
            context_usage,
            ..Default::default()
        };
    }

    AcpSessionOptions {
        config_options: session_config_options,
        context_usage,
        ..Default::default()
    }
}

fn session_config_option_from_protocol(
    option: &SessionConfigOption,
) -> Option<AcpSessionConfigOption> {
    let kind = match &option.kind {
        SessionConfigKind::Select(select) => {
            let options = match &select.options {
                SessionConfigSelectOptions::Ungrouped(options) => options
                    .iter()
                    .map(session_config_select_option_from_protocol)
                    .collect(),
                SessionConfigSelectOptions::Grouped(groups) => groups
                    .iter()
                    .flat_map(|group| {
                        group
                            .options
                            .iter()
                            .map(session_config_select_option_from_protocol)
                    })
                    .collect(),
                _ => Vec::new(),
            };
            AcpSessionConfigKind::Select {
                current_value: select.current_value.to_string(),
                options,
            }
        }
        SessionConfigKind::Boolean(boolean) => AcpSessionConfigKind::Boolean {
            current_value: boolean.current_value,
        },
        _ => return None,
    };

    Some(AcpSessionConfigOption {
        id: option.id.to_string(),
        name: option.name.clone(),
        description: option.description.clone(),
        category: option
            .category
            .as_ref()
            .and_then(|category| match category {
                SessionConfigOptionCategory::Mode => Some("mode".to_string()),
                SessionConfigOptionCategory::Model => Some("model".to_string()),
                SessionConfigOptionCategory::ThoughtLevel => Some("thought_level".to_string()),
                SessionConfigOptionCategory::Other(value) => Some(value.clone()),
                _ => None,
            }),
        kind,
    })
}

fn session_config_select_option_from_protocol(
    option: &agent_client_protocol::schema::SessionConfigSelectOption,
) -> AcpSessionConfigSelectOption {
    AcpSessionConfigSelectOption {
        value: option.value.to_string(),
        name: option.name.clone(),
        description: option.description.clone(),
    }
}

pub(super) fn model_config_id(config_options: &[SessionConfigOption]) -> Option<String> {
    model_config_option(config_options).map(|option| option.id.to_string())
}

fn model_option_from_model_info(model: &ModelInfo) -> AcpSessionModelOption {
    let id = model.model_id.to_string();
    AcpSessionModelOption {
        provider_name: provider_name_from_model_identity(&id, model.description.as_deref()),
        id,
        name: model.name.clone(),
        description: model.description.clone(),
    }
}

fn provider_name_from_model_identity(id: &str, description: Option<&str>) -> Option<String> {
    description
        .and_then(provider_prefix)
        .or_else(|| provider_prefix(id))
}

fn normalized_provider_name(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn provider_prefix(value: &str) -> Option<String> {
    let (provider, model) = value.trim().split_once('/')?;
    let provider = provider.trim();
    let model = model.trim();
    if provider.is_empty() || model.is_empty() {
        None
    } else {
        Some(provider.to_string())
    }
}

fn model_config_option(config_options: &[SessionConfigOption]) -> Option<&SessionConfigOption> {
    config_options
        .iter()
        .find(|option| matches!(option.category, Some(SessionConfigOptionCategory::Model)))
        .or_else(|| {
            config_options.iter().find(|option| {
                let id = option.id.to_string().to_ascii_lowercase();
                let name = option.name.to_ascii_lowercase();
                id == "model" || id.ends_with("_model") || name.contains("model")
            })
        })
        .filter(|option| matches!(option.kind, SessionConfigKind::Select(_)))
}

fn select_model_values(
    option: &SessionConfigOption,
) -> (Option<String>, Vec<AcpSessionModelOption>) {
    let SessionConfigKind::Select(select) = &option.kind else {
        return (None, Vec::new());
    };

    let models = match &select.options {
        SessionConfigSelectOptions::Ungrouped(options) => options
            .iter()
            .map(|option| {
                let id = option.value.to_string();
                AcpSessionModelOption {
                    provider_name: provider_name_from_model_identity(
                        &id,
                        option.description.as_deref(),
                    ),
                    id,
                    name: option.name.clone(),
                    description: option.description.clone(),
                }
            })
            .collect(),
        SessionConfigSelectOptions::Grouped(groups) => groups
            .iter()
            .flat_map(|group| {
                group.options.iter().map(|option| {
                    let id = option.value.to_string();
                    AcpSessionModelOption {
                        provider_name: normalized_provider_name(&group.name).or_else(|| {
                            provider_name_from_model_identity(&id, option.description.as_deref())
                        }),
                        id,
                        name: option.name.clone(),
                        description: option.description.clone(),
                    }
                })
            })
            .collect(),
        _ => Vec::new(),
    };

    (Some(select.current_value.to_string()), models)
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::schema::{ModelInfo, SessionConfigOption};

    #[test]
    fn legacy_session_options_round_trip_without_advertising_combined_metadata() {
        let legacy = serde_json::json!({
            "currentModelId": null, "availableModels": [], "modelConfigId": null,
            "configOptions": [], "contextUsage": null
        });
        let options: AcpSessionOptions = serde_json::from_value(legacy.clone()).unwrap();
        assert!(options.available_commands.is_none());
        assert_eq!(serde_json::to_value(options).unwrap(), legacy);
    }

    #[test]
    fn combined_metadata_distinguishes_empty_commands_from_legacy_absence() {
        let mut options = AcpSessionOptions::default();
        options.available_commands = Some(Vec::new());
        let payload = serde_json::to_value(&options).unwrap();
        assert_eq!(payload["availableCommands"], serde_json::json!([]));
        let restored: AcpSessionOptions = serde_json::from_value(payload).unwrap();
        assert_eq!(restored.available_commands, Some(Vec::new()));
    }

    #[test]
    fn converts_native_model_state() {
        let state = SessionModelState::new("gpt-5.4", vec![ModelInfo::new("gpt-5.4", "GPT 5.4")]);

        let options = session_options_from_state(Some(&state), &[], None);

        assert_eq!(options.current_model_id.as_deref(), Some("gpt-5.4"));
        assert_eq!(options.available_models.len(), 1);
        assert_eq!(options.available_models[0].name, "GPT 5.4");
        assert!(options.model_config_id.is_none());
    }

    #[test]
    fn extracts_provider_name_from_native_model_identity() {
        let state = SessionModelState::new(
            "openai/gpt-5.4",
            vec![ModelInfo::new("openai/gpt-5.4", "GPT 5.4")],
        );

        let options = session_options_from_state(Some(&state), &[], None);

        assert_eq!(
            options.available_models[0].provider_name.as_deref(),
            Some("openai")
        );
    }

    #[test]
    fn converts_model_config_option_fallback() {
        let config = SessionConfigOption::select(
            "model",
            "Model",
            "fast",
            vec![
                agent_client_protocol::schema::SessionConfigSelectOption::new("fast", "Fast"),
                agent_client_protocol::schema::SessionConfigSelectOption::new("smart", "Smart"),
            ],
        )
        .category(SessionConfigOptionCategory::Model);

        let options = session_options_from_state(None, &[config], None);

        assert_eq!(options.current_model_id.as_deref(), Some("fast"));
        assert_eq!(options.model_config_id.as_deref(), Some("model"));
        assert_eq!(options.available_models.len(), 2);
        assert_eq!(options.available_models[1].id, "smart");
    }

    #[test]
    fn extracts_provider_name_from_model_config_description() {
        let config = SessionConfigOption::select(
            "model",
            "Model",
            "openai/gpt-5.4",
            vec![
                agent_client_protocol::schema::SessionConfigSelectOption::new(
                    "openai/gpt-5.4",
                    "GPT 5.4",
                )
                .description("openai/gpt-5.4"),
            ],
        )
        .category(SessionConfigOptionCategory::Model);

        let options = session_options_from_state(None, &[config], None);

        assert_eq!(
            options.available_models[0].provider_name.as_deref(),
            Some("openai")
        );
    }

    #[test]
    fn preserves_model_config_group_name_as_provider_name() {
        let config = SessionConfigOption::select(
            "model",
            "Model",
            "openai/gpt-5.4",
            vec![
                agent_client_protocol::schema::SessionConfigSelectGroup::new(
                    "openai",
                    "OpenAI",
                    vec![
                        agent_client_protocol::schema::SessionConfigSelectOption::new(
                            "openai/gpt-5.4",
                            "GPT 5.4",
                        ),
                    ],
                ),
            ],
        )
        .category(SessionConfigOptionCategory::Model);

        let options = session_options_from_state(None, &[config], None);

        assert_eq!(
            options.available_models[0].provider_name.as_deref(),
            Some("OpenAI")
        );
    }

    #[test]
    fn includes_context_usage() {
        let state = SessionModelState::new("gpt-5.4", vec![ModelInfo::new("gpt-5.4", "GPT 5.4")]);
        let usage = AcpSessionContextUsage {
            used: 42_000,
            size: 128_000,
            cost: Some(agent_client_protocol::schema::Cost::new(0.12, "USD")),
        };

        let options = session_options_from_state(Some(&state), &[], Some(&usage));

        let context_usage = options.context_usage.expect("context usage");
        assert_eq!(context_usage.used, 42_000);
        assert_eq!(context_usage.size, 128_000);
        assert_eq!(
            context_usage
                .cost
                .as_ref()
                .map(|cost| cost.currency.as_str()),
            Some("USD")
        );
    }

    #[test]
    fn exposes_select_and_boolean_session_config_options() {
        let select = SessionConfigOption::select(
            "fast-mode",
            "Fast mode",
            "off",
            vec![
                agent_client_protocol::schema::SessionConfigSelectOption::new("off", "Off"),
                agent_client_protocol::schema::SessionConfigSelectOption::new("on", "On"),
            ],
        )
        .description("1.5x speed, increased usage");
        let boolean = SessionConfigOption::boolean("web-search", "Web search", true);

        let options = session_options_from_state(None, &[select, boolean], None);

        assert_eq!(options.config_options.len(), 2);
        assert_eq!(options.config_options[0].id, "fast-mode");
        assert_eq!(
            options.config_options[0].kind,
            AcpSessionConfigKind::Select {
                current_value: "off".to_string(),
                options: vec![
                    AcpSessionConfigSelectOption {
                        value: "off".to_string(),
                        name: "Off".to_string(),
                        description: None,
                    },
                    AcpSessionConfigSelectOption {
                        value: "on".to_string(),
                        name: "On".to_string(),
                        description: None,
                    },
                ],
            }
        );
        assert_eq!(
            options.config_options[1].kind,
            AcpSessionConfigKind::Boolean {
                current_value: true,
            }
        );
    }

    #[test]
    fn converts_available_command_with_and_without_input() {
        use agent_client_protocol::schema::{
            AvailableCommand, AvailableCommandInput, UnstructuredCommandInput,
        };

        let with_input = AvailableCommand::new("create_plan", "Draft an execution plan").input(
            AvailableCommandInput::Unstructured(UnstructuredCommandInput::new("what to plan")),
        );
        let converted = AcpAvailableCommand::from(with_input);
        assert_eq!(converted.name, "create_plan");
        assert_eq!(converted.description, "Draft an execution plan");
        assert_eq!(converted.input_hint.as_deref(), Some("what to plan"));

        let converted =
            AcpAvailableCommand::from(AvailableCommand::new("compact", "Compact the context"));
        assert_eq!(converted.name, "compact");
        assert!(converted.input_hint.is_none());
    }
}
