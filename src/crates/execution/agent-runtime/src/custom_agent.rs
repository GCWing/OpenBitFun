//! Custom agent portable schema and serialization decisions.

use crate::prompt::{UserContextPolicy, UserContextSection};
use openbitfun_core_types::product_identity::hidden_data_directory;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_yaml::{Mapping, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

pub const DEFAULT_CUSTOM_MODE_TOOLS: &[&str] = &[
    "Read",
    "Glob",
    "Grep",
    "Write",
    "Edit",
    "Delete",
    "ExecCommand",
    "WriteStdin",
    "ExecControl",
    "AgentSpawn",
    "AgentSendInput",
    "AgentControl",
    "AgentList",
    "AgentWait",
    "ListModels",
    "Skill",
    "WebSearch",
    "WebFetch",
    "get_goal",
    "create_goal",
    "update_goal",
];
pub const DEFAULT_CUSTOM_SUBAGENT_TOOLS: &[&str] = &["LS", "Read", "Glob", "Grep"];
pub const DEFAULT_CUSTOM_MODE_READONLY: bool = false;
pub const DEFAULT_CUSTOM_SUBAGENT_READONLY: bool = true;
pub const DEFAULT_CUSTOM_SUBAGENT_REVIEW: bool = false;
pub const DEFAULT_CUSTOM_MODE_MODEL: &str = "primary";
pub const DEFAULT_CUSTOM_SUBAGENT_MODEL: &str = "fast";
// Only OpenBitFun custom agents are loaded. Unlike skills, custom subagents from
// different vendors do not share a stable schema or compatible tool contract.
pub const CUSTOM_AGENT_PROJECT_AGENT_SUBDIRS: &[(&str, &str)] =
    &[(hidden_data_directory(), "agents")];
pub const CUSTOM_AGENT_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CustomAgentKind {
    Mode,
    Subagent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CustomAgentLevel {
    Project,
    User,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CustomAgentDefinition {
    pub id: String,
    pub name: String,
    pub description: String,
    pub kind: CustomAgentKind,
    pub tools: Vec<String>,
    pub prompt: String,
    pub readonly: bool,
    pub review: bool,
    pub level: CustomAgentLevel,
    pub model: String,
    /// Whether front matter explicitly contains a `model` field.
    ///
    /// Normal subagents without this field use the shared subagent default,
    /// while an explicit `fast` remains a real per-subagent override.
    pub model_is_explicit: bool,
    pub user_context_policy: UserContextPolicy,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CustomAgentFrontMatterMetadata {
    pub schema_version: Option<u32>,
    pub generated_id_from_name: bool,
    pub used_default_tools: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedCustomAgentDefinition {
    pub definition: CustomAgentDefinition,
    pub metadata: CustomAgentFrontMatterMetadata,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CustomAgentDefinitionError {
    MissingName,
    MissingDescription,
    MissingId,
    InvalidKind,
    ReviewModeRequiresSubagent,
    InvalidUserContextPolicy,
}

impl CustomAgentDefinitionError {
    pub const fn message(self) -> &'static str {
        match self {
            Self::MissingName => "Missing name field",
            Self::MissingDescription => "Missing description field",
            Self::MissingId => "Missing id field",
            Self::InvalidKind => "Invalid kind field",
            Self::ReviewModeRequiresSubagent => "review: true is only supported for subagents",
            Self::InvalidUserContextPolicy => "Invalid user_context_policy field",
        }
    }
}

impl CustomAgentDefinition {
    pub fn new(
        id: String,
        name: String,
        description: String,
        kind: CustomAgentKind,
        tools: Vec<String>,
        prompt: String,
        readonly: bool,
        level: CustomAgentLevel,
        model: String,
        user_context_policy: UserContextPolicy,
    ) -> Self {
        Self {
            id,
            name,
            description,
            kind,
            tools,
            prompt,
            readonly,
            review: DEFAULT_CUSTOM_SUBAGENT_REVIEW,
            level,
            model,
            model_is_explicit: true,
            user_context_policy,
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn from_front_matter_fields(
        id: Option<&str>,
        name: Option<&str>,
        description: Option<&str>,
        kind: Option<CustomAgentKind>,
        tools: Option<Vec<String>>,
        readonly: Option<bool>,
        review: Option<bool>,
        model: Option<&str>,
        user_context_policy: Option<UserContextPolicy>,
        prompt: String,
        level: CustomAgentLevel,
    ) -> Result<ParsedCustomAgentDefinition, CustomAgentDefinitionError> {
        let kind = kind.unwrap_or(CustomAgentKind::Subagent);
        let name = name
            .ok_or(CustomAgentDefinitionError::MissingName)?
            .trim()
            .to_string();
        let description = description
            .ok_or(CustomAgentDefinitionError::MissingDescription)?
            .trim()
            .to_string();

        let (id, generated_id_from_name) = match id.map(str::trim).filter(|value| !value.is_empty())
        {
            Some(value) => (value.to_string(), false),
            None if !name.is_empty() => (name.clone(), true),
            None => return Err(CustomAgentDefinitionError::MissingId),
        };

        let used_default_tools = tools.is_none();
        let tools = tools.unwrap_or_else(|| default_custom_agent_tools(kind));
        let review = review.unwrap_or(DEFAULT_CUSTOM_SUBAGENT_REVIEW);
        if review && kind != CustomAgentKind::Subagent {
            return Err(CustomAgentDefinitionError::ReviewModeRequiresSubagent);
        }

        let readonly = match kind {
            CustomAgentKind::Mode => readonly.unwrap_or(DEFAULT_CUSTOM_MODE_READONLY),
            CustomAgentKind::Subagent => {
                if review {
                    true
                } else {
                    readonly.unwrap_or(DEFAULT_CUSTOM_SUBAGENT_READONLY)
                }
            }
        };

        let model_is_explicit = model.is_some();
        let model = custom_agent_model_or_default(kind, model).to_string();
        let user_context_policy =
            user_context_policy.unwrap_or_else(|| default_custom_agent_user_context_policy(kind));

        Ok(ParsedCustomAgentDefinition {
            definition: Self {
                id,
                name,
                description,
                kind,
                tools,
                prompt,
                readonly,
                review,
                level,
                model,
                model_is_explicit,
                user_context_policy,
            },
            metadata: CustomAgentFrontMatterMetadata {
                schema_version: None,
                generated_id_from_name,
                used_default_tools,
            },
        })
    }

    pub fn tools_are_default(&self) -> bool {
        custom_agent_tools_are_default(self.kind, &self.tools)
    }

    pub fn should_save_readonly(&self) -> bool {
        custom_agent_readonly_should_save(self.kind, self.readonly)
    }

    pub fn should_save_review(&self) -> bool {
        custom_agent_review_should_save(self.kind, self.review)
    }

    pub fn should_save_model(&self) -> bool {
        match self.kind {
            CustomAgentKind::Mode => custom_agent_model_should_save(self.kind, &self.model),
            CustomAgentKind::Subagent => self.model_is_explicit,
        }
    }

    pub fn should_save_user_context_policy(&self) -> bool {
        custom_agent_user_context_policy_should_save(self.kind, &self.user_context_policy)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CustomAgentDiscoveryRoots {
    pub workspace_root: Option<PathBuf>,
    pub openbitfun_user_agents_dir: Option<PathBuf>,
    pub home_dir: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CustomAgentDirEntry {
    pub path: PathBuf,
    pub level: CustomAgentLevel,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadedCustomAgentDefinition {
    pub path: PathBuf,
    pub definition: CustomAgentDefinition,
    pub metadata: CustomAgentFrontMatterMetadata,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CustomAgentLoadError {
    pub path: PathBuf,
    pub error: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CustomAgentLoadReport {
    pub definitions: Vec<LoadedCustomAgentDefinition>,
    pub errors: Vec<CustomAgentLoadError>,
}

#[derive(Debug, Clone, Copy)]
pub struct CustomAgentValidationContext<'a> {
    pub valid_tools: &'a [String],
    pub readonly_tools: &'a [String],
    pub valid_models: &'a [String],
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CustomAgentValidationReport {
    pub default_mode_tools_used: bool,
    pub invalid_tools: Vec<String>,
    pub writable_review_tools: Vec<String>,
    pub model_fallback: Option<CustomAgentModelFallback>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CustomAgentModelFallback {
    pub original: String,
    pub fallback: String,
}

struct CustomAgentCandidate {
    definition: CustomAgentDefinition,
    metadata: CustomAgentFrontMatterMetadata,
    root_priority: usize,
    path: PathBuf,
}

pub fn default_custom_agent_tools(kind: CustomAgentKind) -> Vec<String> {
    match kind {
        CustomAgentKind::Mode => DEFAULT_CUSTOM_MODE_TOOLS,
        CustomAgentKind::Subagent => DEFAULT_CUSTOM_SUBAGENT_TOOLS,
    }
    .iter()
    .map(|tool| (*tool).to_string())
    .collect()
}

fn default_custom_agent_tools_slice(kind: CustomAgentKind) -> &'static [&'static str] {
    match kind {
        CustomAgentKind::Mode => DEFAULT_CUSTOM_MODE_TOOLS,
        CustomAgentKind::Subagent => DEFAULT_CUSTOM_SUBAGENT_TOOLS,
    }
}

pub fn custom_agent_tools_are_default(kind: CustomAgentKind, tools: &[String]) -> bool {
    let default_tools = default_custom_agent_tools_slice(kind);
    tools.len() == default_tools.len()
        && tools
            .iter()
            .zip(default_tools.iter())
            .all(|(actual, expected)| actual == *expected)
}

pub fn default_custom_agent_user_context_policy(kind: CustomAgentKind) -> UserContextPolicy {
    let base = UserContextPolicy::empty()
        .with_workspace_context()
        .with_workspace_instructions()
        .with_project_layout();
    match kind {
        CustomAgentKind::Mode | CustomAgentKind::Subagent => base,
    }
}

pub fn custom_agent_possible_dirs(roots: &CustomAgentDiscoveryRoots) -> Vec<CustomAgentDirEntry> {
    let mut entries = Vec::new();

    if let Some(workspace_root) = &roots.workspace_root {
        for (parent, sub) in CUSTOM_AGENT_PROJECT_AGENT_SUBDIRS {
            let path = workspace_root.join(parent).join(sub);
            if path.exists() && path.is_dir() {
                entries.push(CustomAgentDirEntry {
                    path,
                    level: CustomAgentLevel::Project,
                });
            }
        }
    }

    if let Some(openbitfun_agents) = &roots.openbitfun_user_agents_dir {
        if openbitfun_agents.exists() && openbitfun_agents.is_dir() {
            entries.push(CustomAgentDirEntry {
                path: openbitfun_agents.clone(),
                level: CustomAgentLevel::User,
            });
        }
    }

    entries
}

pub fn load_custom_agent_definitions(roots: &CustomAgentDiscoveryRoots) -> CustomAgentLoadReport {
    let mut candidates = Vec::new();
    let mut errors = Vec::new();

    for (root_priority, entry) in custom_agent_possible_dirs(roots).into_iter().enumerate() {
        for md_path in list_custom_agent_markdown_files(&entry.path) {
            match custom_agent_read_markdown_file(&md_path, entry.level) {
                Ok(parsed) => {
                    if parsed.definition.kind == CustomAgentKind::Mode
                        && parsed.definition.level == CustomAgentLevel::Project
                    {
                        errors.push(CustomAgentLoadError {
                            path: md_path,
                            error: "Project-scoped custom modes are not supported".to_string(),
                        });
                        continue;
                    }

                    candidates.push(CustomAgentCandidate {
                        definition: parsed.definition,
                        metadata: parsed.metadata,
                        root_priority,
                        path: md_path,
                    });
                }
                Err(error) => errors.push(CustomAgentLoadError {
                    path: md_path,
                    error,
                }),
            }
        }
    }

    candidates.sort_by(|a, b| {
        a.root_priority
            .cmp(&b.root_priority)
            .then_with(|| {
                a.definition
                    .id
                    .to_lowercase()
                    .cmp(&b.definition.id.to_lowercase())
            })
            .then_with(|| a.definition.id.cmp(&b.definition.id))
            .then_with(|| a.path.cmp(&b.path))
    });

    let mut definitions = Vec::new();
    let mut seen_ids = HashSet::new();
    for candidate in candidates {
        if seen_ids.insert(candidate.definition.id.to_lowercase()) {
            definitions.push(LoadedCustomAgentDefinition {
                path: candidate.path,
                definition: candidate.definition,
                metadata: candidate.metadata,
            });
        }
    }

    CustomAgentLoadReport {
        definitions,
        errors,
    }
}

pub fn validate_custom_agent_definition(
    definition: &mut CustomAgentDefinition,
    metadata: &CustomAgentFrontMatterMetadata,
    context: CustomAgentValidationContext<'_>,
) -> CustomAgentValidationReport {
    let default_mode_tools_used =
        metadata.used_default_tools && definition.kind == CustomAgentKind::Mode;

    let valid_tools_set: HashSet<&str> = context.valid_tools.iter().map(String::as_str).collect();
    let original_tools = std::mem::take(&mut definition.tools);
    let (valid_tools, invalid_tools): (Vec<_>, Vec<_>) = original_tools
        .into_iter()
        .partition(|tool| valid_tools_set.contains(tool.as_str()));

    let writable_review_tools;
    if definition.kind == CustomAgentKind::Subagent && definition.review {
        definition.readonly = true;
        let readonly_tools_set: HashSet<&str> =
            context.readonly_tools.iter().map(String::as_str).collect();
        let (review_tools, writable_tools): (Vec<_>, Vec<_>) = valid_tools
            .into_iter()
            .partition(|tool| readonly_tools_set.contains(tool.as_str()));
        definition.tools = review_tools;
        writable_review_tools = writable_tools;
    } else {
        definition.tools = valid_tools;
        writable_review_tools = Vec::new();
    }

    let model_fallback = if context.valid_models.contains(&definition.model) {
        None
    } else {
        let original_model = definition.model.clone();
        let fallback_model = custom_agent_model_or_default(definition.kind, None).to_string();
        definition.model = fallback_model.clone();
        Some(CustomAgentModelFallback {
            original: original_model,
            fallback: fallback_model,
        })
    };

    CustomAgentValidationReport {
        default_mode_tools_used,
        invalid_tools,
        writable_review_tools,
        model_fallback,
    }
}

pub fn custom_agent_review_writable_tools(
    tools: &[String],
    readonly_tools: &[String],
) -> Vec<String> {
    let readonly_tools_set: HashSet<&str> = readonly_tools.iter().map(String::as_str).collect();
    tools
        .iter()
        .filter(|tool| !readonly_tools_set.contains(tool.as_str()))
        .cloned()
        .collect()
}

fn list_custom_agent_markdown_files(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() && path.extension().is_some_and(|ext| ext == "md") {
            out.push(path);
        }
    }
    out.sort();
    out
}

pub fn custom_agent_readonly_should_save(kind: CustomAgentKind, readonly: bool) -> bool {
    readonly
        != match kind {
            CustomAgentKind::Mode => DEFAULT_CUSTOM_MODE_READONLY,
            CustomAgentKind::Subagent => DEFAULT_CUSTOM_SUBAGENT_READONLY,
        }
}

pub fn custom_agent_review_should_save(kind: CustomAgentKind, review: bool) -> bool {
    kind == CustomAgentKind::Subagent && review != DEFAULT_CUSTOM_SUBAGENT_REVIEW
}

pub fn custom_agent_model_or_default(kind: CustomAgentKind, model: Option<&str>) -> &str {
    model.unwrap_or(match kind {
        CustomAgentKind::Mode => DEFAULT_CUSTOM_MODE_MODEL,
        CustomAgentKind::Subagent => DEFAULT_CUSTOM_SUBAGENT_MODEL,
    })
}

pub fn custom_agent_model_should_save(kind: CustomAgentKind, model: &str) -> bool {
    model
        != match kind {
            CustomAgentKind::Mode => DEFAULT_CUSTOM_MODE_MODEL,
            CustomAgentKind::Subagent => DEFAULT_CUSTOM_SUBAGENT_MODEL,
        }
}

pub fn custom_agent_user_context_policy_should_save(
    kind: CustomAgentKind,
    policy: &UserContextPolicy,
) -> bool {
    policy != &default_custom_agent_user_context_policy(kind)
}

pub fn custom_agent_read_markdown_file(
    path: impl AsRef<Path>,
    level: CustomAgentLevel,
) -> Result<ParsedCustomAgentDefinition, String> {
    let contents = std::fs::read_to_string(path)
        .map_err(|error| format!("Failed to read markdown file: {error}"))?;

    custom_agent_read_markdown_str(&contents, level)
        .map_err(|error| format!("Failed to parse markdown file: {error}"))
}

pub fn custom_agent_read_markdown_str(
    contents: &str,
    level: CustomAgentLevel,
) -> Result<ParsedCustomAgentDefinition, String> {
    static FRONT_MATTER_REGEX: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        Regex::new(r"(?s)^---\r?\n(.*?)\r?\n---").expect("front matter regex pattern is valid")
    });
    let captures = FRONT_MATTER_REGEX
        .captures(contents)
        .ok_or_else(|| "Failed to capture content".to_string())?;
    let yaml = captures
        .get(1)
        .ok_or_else(|| "Failed to get captures".to_string())?
        .as_str();
    let metadata: Value =
        serde_yaml::from_str(yaml).map_err(|error| format!("Failed to parse YAML: {error}"))?;

    let front_matter_end = captures
        .get(0)
        .ok_or_else(|| "Failed to get captures".to_string())?
        .end();
    let prompt = contents[front_matter_end..].trim_start().to_string();

    custom_agent_definition_from_metadata(&metadata, prompt, level)
}

pub fn custom_agent_save_markdown_file(
    path: impl AsRef<Path>,
    definition: &CustomAgentDefinition,
) -> Result<(), String> {
    let metadata = custom_agent_markdown_metadata(definition);
    let yaml = serde_yaml::to_string(&metadata)
        .map_err(|error| format!("Failed to serialize YAML: {error}"))?;
    let contents = format!(
        "---\n{}\n---\n\n{}",
        yaml.trim_end(),
        definition.prompt.trim_start()
    );

    std::fs::write(path, contents)
        .map_err(|error| format!("Failed to write markdown file: {error}"))
}

fn custom_agent_definition_from_metadata(
    metadata: &Value,
    prompt: String,
    level: CustomAgentLevel,
) -> Result<ParsedCustomAgentDefinition, String> {
    let kind = match metadata.get("kind").and_then(Value::as_str) {
        Some("mode") => Some(CustomAgentKind::Mode),
        Some("subagent") => Some(CustomAgentKind::Subagent),
        Some(_) => {
            return Err(CustomAgentDefinitionError::InvalidKind
                .message()
                .to_string())
        }
        None => None,
    };

    let parsed = CustomAgentDefinition::from_front_matter_fields(
        metadata.get("id").and_then(Value::as_str),
        metadata.get("name").and_then(Value::as_str),
        metadata.get("description").and_then(Value::as_str),
        kind,
        metadata_tools(metadata, kind.unwrap_or(CustomAgentKind::Subagent))?,
        metadata.get("readonly").and_then(Value::as_bool),
        metadata.get("review").and_then(Value::as_bool),
        metadata.get("model").and_then(Value::as_str),
        metadata_user_context_policy(metadata)?,
        prompt,
        level,
    )
    .map_err(|error| error.message().to_string())?;

    let schema_version = metadata
        .get("schema_version")
        .and_then(Value::as_u64)
        .map(|value| value as u32);

    Ok(ParsedCustomAgentDefinition {
        metadata: CustomAgentFrontMatterMetadata {
            schema_version,
            ..parsed.metadata
        },
        ..parsed
    })
}

fn metadata_tools(metadata: &Value, kind: CustomAgentKind) -> Result<Option<Vec<String>>, String> {
    let Some(value) = metadata.get("tools") else {
        return Ok(None);
    };

    match value {
        Value::String(raw) => Ok(Some(
            raw.split(',')
                .map(|item| item.trim().to_string())
                .filter(|item| !item.is_empty())
                .collect(),
        )),
        Value::Sequence(values) => {
            let mut tools = Vec::new();
            for item in values {
                let Some(tool) = item.as_str() else {
                    return Err(format!("Invalid tools field for {:?}", kind));
                };
                let tool = tool.trim();
                if !tool.is_empty() {
                    tools.push(tool.to_string());
                }
            }
            Ok(Some(tools))
        }
        _ => Err(format!("Invalid tools field for {:?}", kind)),
    }
}

fn metadata_user_context_policy(metadata: &Value) -> Result<Option<UserContextPolicy>, String> {
    let Some(value) = metadata.get("user_context_policy") else {
        return Ok(None);
    };

    let Value::Sequence(values) = value else {
        return Err(CustomAgentDefinitionError::InvalidUserContextPolicy
            .message()
            .to_string());
    };

    let mut policy = UserContextPolicy::empty();
    for item in values {
        let Some(section) = item.as_str() else {
            return Err(CustomAgentDefinitionError::InvalidUserContextPolicy
                .message()
                .to_string());
        };
        let section = match section.trim() {
            "workspace_context" => UserContextSection::WorkspaceContext,
            "workspace_instructions" => UserContextSection::WorkspaceInstructions,
            "project_layout" => UserContextSection::ProjectLayout,
            "memory_summary" => UserContextSection::MemorySummary,
            _ => {
                return Err(CustomAgentDefinitionError::InvalidUserContextPolicy
                    .message()
                    .to_string())
            }
        };
        policy = policy.with_section(section);
    }

    Ok(Some(policy))
}

fn custom_agent_markdown_metadata(definition: &CustomAgentDefinition) -> Value {
    let mut metadata = Mapping::new();
    metadata.insert(
        Value::String("schema_version".into()),
        Value::Number(CUSTOM_AGENT_SCHEMA_VERSION.into()),
    );
    metadata.insert(
        Value::String("kind".into()),
        Value::String(match definition.kind {
            CustomAgentKind::Mode => "mode".to_string(),
            CustomAgentKind::Subagent => "subagent".to_string(),
        }),
    );
    metadata.insert(
        Value::String("id".into()),
        Value::String(definition.id.clone()),
    );
    metadata.insert(
        Value::String("name".into()),
        Value::String(definition.name.clone()),
    );
    metadata.insert(
        Value::String("description".into()),
        Value::String(definition.description.clone()),
    );

    if !definition.tools_are_default() {
        metadata.insert(
            Value::String("tools".into()),
            Value::Sequence(
                definition
                    .tools
                    .iter()
                    .cloned()
                    .map(Value::String)
                    .collect(),
            ),
        );
    }
    if definition.should_save_readonly() {
        metadata.insert(
            Value::String("readonly".into()),
            Value::Bool(definition.readonly),
        );
    }
    if definition.should_save_review() {
        metadata.insert(
            Value::String("review".into()),
            Value::Bool(definition.review),
        );
    }
    if definition.should_save_model() {
        metadata.insert(
            Value::String("model".into()),
            Value::String(definition.model.clone()),
        );
    }
    if definition.should_save_user_context_policy() {
        metadata.insert(
            Value::String("user_context_policy".into()),
            Value::Sequence(
                definition
                    .user_context_policy
                    .sections
                    .iter()
                    .map(|section| {
                        Value::String(
                            match section {
                                UserContextSection::WorkspaceContext => "workspace_context",
                                UserContextSection::WorkspaceInstructions => {
                                    "workspace_instructions"
                                }
                                UserContextSection::ProjectLayout => "project_layout",
                                UserContextSection::MemorySummary => "memory_summary",
                            }
                            .to_string(),
                        )
                    })
                    .collect(),
            ),
        );
    }

    Value::Mapping(metadata)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn custom_agent_user_context_policy_round_trips_memory_summary() {
        let definition = CustomAgentDefinition {
            id: "memory-mode".to_string(),
            name: "Memory Mode".to_string(),
            description: "Test".to_string(),
            kind: CustomAgentKind::Mode,
            tools: vec!["Read".to_string()],
            prompt: "Prompt".to_string(),
            readonly: false,
            review: false,
            level: CustomAgentLevel::User,
            model: "primary".to_string(),
            model_is_explicit: false,
            user_context_policy: UserContextPolicy::empty()
                .with_workspace_context()
                .with_workspace_instructions()
                .with_project_layout()
                .with_memory_summary(),
        };

        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time should move forward")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("custom-agent-{stamp}.md"));

        custom_agent_save_markdown_file(&path, &definition).expect("markdown should save");
        let contents = std::fs::read_to_string(&path).expect("markdown should read");
        let parsed = custom_agent_read_markdown_str(&contents, CustomAgentLevel::User)
            .expect("markdown should parse");
        let _ = std::fs::remove_file(&path);

        assert!(parsed
            .definition
            .user_context_policy
            .includes(UserContextSection::MemorySummary));
    }

    #[test]
    fn metadata_user_context_policy_accepts_memory_summary() {
        let mut yaml = serde_yaml::Mapping::new();
        yaml.insert(
            serde_yaml::Value::String("user_context_policy".to_string()),
            serde_yaml::to_value(vec!["workspace_context", "memory_summary"])
                .expect("yaml should serialize"),
        );
        let policy = metadata_user_context_policy(&serde_yaml::Value::Mapping(yaml))
            .expect("policy should parse")
            .expect("policy should exist");

        assert!(policy.includes(UserContextSection::WorkspaceContext));
        assert!(policy.includes(UserContextSection::MemorySummary));
    }
}
