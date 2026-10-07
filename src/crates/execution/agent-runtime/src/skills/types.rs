use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_yaml::Value;
use std::collections::HashSet;
use std::path::Path;

const CLAUDE_DESCRIPTION_MAX_CHARS: usize = 1536;
const CLAUDE_ARGUMENT_NAMES_MAX: usize = 32;

/// A discovery problem is separate from the usable skill inventory.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillScanDiagnostic {
    pub path: String,
    pub source_id: String,
    pub message: String,
    /// A required declaration this runtime cannot honor. The skill stays unloaded.
    /// Older hosts omit this field and retain ordinary scan-error presentation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unsupported_field: Option<String>,
}

impl SkillScanDiagnostic {
    pub fn from_parse_error(
        path: impl Into<String>,
        source_id: impl Into<String>,
        error: &SkillParseError,
    ) -> Self {
        Self {
            path: path.into(),
            source_id: source_id.into(),
            message: error.to_string(),
            unsupported_field: match error {
                SkillParseError::UnsupportedClaudeField(field) => Some(field.clone()),
                _ => None,
            },
        }
    }

    pub fn to_xml(&self) -> String {
        let text = format!(
            "Skill discovery notice at {} ({}): {}",
            self.path, self.source_id, self.message
        );
        let escaped = text
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;");
        format!("<skill_discovery_warning>{escaped}</skill_discovery_warning>")
    }
}

/// Opt-in report; legacy list consumers continue to receive the skills array.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillScanReport<T = SkillInfo> {
    pub skills: Vec<T>,
    #[serde(default)]
    pub diagnostics: Vec<SkillScanDiagnostic>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SkillSourceDialect {
    AgentSkills,
    ClaudeCode,
    Codex,
    Pi,
    DeepSeekHarness,
}

#[derive(Debug, Clone, thiserror::Error, PartialEq, Eq)]
pub enum SkillParseError {
    #[error("Invalid SKILL.md format: {0}")]
    InvalidFormat(String),
    #[error("Claude skill requires unsupported field '{0}'; this skill was not loaded")]
    UnsupportedClaudeField(String),
    #[error("Missing required field '{0}' in SKILL.md")]
    MissingField(&'static str),
    #[error("Invalid skill path: {0}")]
    InvalidPath(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SkillLocation {
    User,
    Project,
}

impl SkillLocation {
    pub fn as_str(&self) -> &'static str {
        match self {
            SkillLocation::User => "user",
            SkillLocation::Project => "project",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillImportOrigin {
    pub schema_version: u32,
    pub import_id: String,
    pub source_key: String,
    pub source_path: String,
    pub source_id: String,
    pub source_label: String,
    pub source_slot: String,
    pub fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    pub key: String,
    pub name: String,
    pub description: String,
    pub path: String,
    /// Markdown entry relative to `path`; absent in legacy directory bundles.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry_file: Option<String>,
    pub level: SkillLocation,
    pub source_slot: String,
    /// Ecosystem identity shared by all roots owned by the same source.
    #[serde(default)]
    pub source_id: String,
    /// Stable product name supplied by the source definition.
    #[serde(default)]
    pub source_label: String,
    /// Repository recorded by the installer, distinct from the discovery ecosystem.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installation_source: Option<String>,
    /// Provenance of a native copy; storage ownership stays with source_id/source_slot.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub import_origin: Option<SkillImportOrigin>,
    pub dir_name: String,
    #[serde(default)]
    pub is_builtin: bool,
    #[serde(default)]
    pub group_key: Option<String>,
    #[serde(default)]
    pub is_shadowed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shadowed_by_key: Option<String>,
    #[serde(default = "default_allow_implicit_invocation", skip_serializing)]
    pub allow_implicit_invocation: bool,
    #[serde(default = "default_allow_user_invocation")]
    pub allow_user_invocation: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub argument_hint: Option<String>,
}

impl SkillInfo {
    /// Native storage ownership, independent of the provenance of an imported copy.
    /// Older payloads may only carry the source slot.
    pub fn is_native(&self) -> bool {
        if self.is_builtin {
            return true;
        }
        let source = if self.source_id.trim().is_empty() {
            self.source_slot.trim()
        } else {
            self.source_id.trim()
        };
        matches!(
            source,
            "" | "openbitfun" | "openbitfun-system" | "openbitfun-user"
        )
    }

    pub fn parser_source_slot(&self) -> &str {
        self.import_origin
            .as_ref()
            .map_or(&self.source_slot, |origin| &origin.source_slot)
    }

    pub fn parser_path(&self) -> String {
        match self
            .entry_file
            .as_deref()
            .filter(|entry| *entry != "SKILL.md")
        {
            Some(entry) => format!(
                "{}/{}",
                self.path.trim_end_matches(['/', '\\']),
                entry.strip_suffix(".md").unwrap_or(entry)
            ),
            None => self.path.clone(),
        }
    }

    pub fn to_xml_desc(&self) -> String {
        format!(
            r#"<skill name="{}">{}</skill>"#,
            self.name, self.description
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModeSkillStateReason {
    ProjectDefaultEnabled,
    DisabledByProjectOverride,
    CustomUserDefaultEnabled,
    BuiltinPolicyEnabled,
    BuiltinPolicyDisabled,
    EnabledByUserOverride,
    DisabledByUserOverride,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModeSkillInfo {
    #[serde(flatten)]
    pub skill: SkillInfo,
    pub default_enabled: bool,
    pub globally_enabled: bool,
    pub effective_enabled: bool,
    pub disabled_by_mode: bool,
    pub selected_for_runtime: bool,
    pub state_reason: ModeSkillStateReason,
}

#[derive(Debug, Clone)]
pub struct SkillData {
    pub key: String,
    pub name: String,
    pub description: String,
    pub content: String,
    pub location: SkillLocation,
    pub path: String,
    pub entry_file: Option<String>,
    pub source_slot: String,
    pub source_id: String,
    pub source_label: String,
    pub dir_name: String,
    pub allow_implicit_invocation: bool,
    pub allow_user_invocation: bool,
    pub argument_hint: Option<String>,
    pub argument_names: Vec<String>,
    /// Compatibility notices accompany both discovery and explicit loading.
    pub compatibility_warnings: Vec<String>,
    /// Validated declarations, activated only when this skill is invoked.
    pub hooks: Option<super::SkillHooks>,
}

fn default_allow_implicit_invocation() -> bool {
    true
}

fn default_allow_user_invocation() -> bool {
    true
}

fn optional_bool(metadata: &Value, field: &'static str) -> Result<Option<bool>, SkillParseError> {
    let Some(value) = metadata.get(field) else {
        return Ok(None);
    };
    value
        .as_bool()
        .map(Some)
        .ok_or_else(|| SkillParseError::InvalidFormat(format!("Field '{field}' must be a boolean")))
}

fn optional_claude_bool(
    metadata: &Value,
    field: &'static str,
) -> Result<Option<bool>, SkillParseError> {
    let Some(value) = metadata.get(field) else {
        return Ok(None);
    };
    let parsed = match value {
        Value::Bool(value) => Some(*value),
        Value::Number(value) if value.as_i64() == Some(1) => Some(true),
        Value::Number(value) if value.as_i64() == Some(0) => Some(false),
        Value::String(value) => match value.to_ascii_lowercase().as_str() {
            "true" | "yes" | "on" | "1" => Some(true),
            "false" | "no" | "off" | "0" => Some(false),
            _ => None,
        },
        _ => None,
    };
    parsed
        .map(Some)
        .ok_or_else(|| SkillParseError::InvalidFormat(format!("Field '{field}' must be a boolean")))
}

fn optional_string(
    metadata: &Value,
    field: &'static str,
) -> Result<Option<String>, SkillParseError> {
    let Some(value) = metadata.get(field) else {
        return Ok(None);
    };
    value
        .as_str()
        .map(|value| Some(value.to_string()))
        .ok_or_else(|| SkillParseError::InvalidFormat(format!("Field '{field}' must be a string")))
}

fn parse_front_matter_markdown(content: &str) -> Result<(Value, String), SkillParseError> {
    static FRONT_MATTER_REGEX: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        Regex::new(r"(?s)^---\r?\n(.*?)\r?\n---").expect("front matter regex pattern is valid")
    });
    let caps = FRONT_MATTER_REGEX
        .captures(content)
        .ok_or_else(|| SkillParseError::InvalidFormat("Failed to capture content".to_string()))?;

    let yaml_content = caps
        .get(1)
        .ok_or_else(|| SkillParseError::InvalidFormat("Failed to get captures".to_string()))?
        .as_str();

    let metadata: Value = serde_yaml::from_str(yaml_content).map_err(|error| {
        SkillParseError::InvalidFormat(format!("Failed to parse YAML: {error}"))
    })?;

    let after_front_matter = caps
        .get(0)
        .ok_or_else(|| SkillParseError::InvalidFormat("Failed to get captures".to_string()))?
        .end();
    let markdown_body = content[after_front_matter..].trim_start();

    Ok((metadata, markdown_body.to_string()))
}

fn directory_name(path: &str) -> Result<String, SkillParseError> {
    Path::new(path)
        .file_name()
        .and_then(|value| value.to_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| SkillParseError::InvalidPath(path.to_string()))
}

fn first_markdown_paragraph(body: &str) -> Option<String> {
    body.replace("\r\n", "\n")
        .split("\n\n")
        .map(str::trim)
        .find(|paragraph| !paragraph.is_empty())
        .map(str::to_string)
}

fn truncate_chars(value: String, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value;
    }
    value.chars().take(max_chars).collect()
}

fn claude_description(metadata: &Value, body: &str) -> Result<String, SkillParseError> {
    let description = optional_string(metadata, "description")?
        .filter(|value| !value.trim().is_empty())
        .or_else(|| first_markdown_paragraph(body))
        .unwrap_or_default();
    let when_to_use =
        optional_string(metadata, "when_to_use")?.filter(|value| !value.trim().is_empty());
    let description = description.trim();
    if description.is_empty() {
        return Err(SkillParseError::MissingField("description"));
    }
    let combined = match when_to_use.as_deref().map(str::trim) {
        None => description.to_string(),
        Some(when_to_use) => {
            format!("{description}\n\nWhen to use: {when_to_use}")
        }
    };
    Ok(truncate_chars(combined, CLAUDE_DESCRIPTION_MAX_CHARS))
}

fn claude_argument_names(metadata: &Value) -> Result<Vec<String>, SkillParseError> {
    let Some(value) = metadata.get("arguments") else {
        return Ok(Vec::new());
    };
    let names = match value {
        Value::String(value) => value.split_whitespace().map(str::to_string).collect(),
        Value::Sequence(values) => values
            .iter()
            .map(|value| {
                value.as_str().map(str::to_string).ok_or_else(|| {
                    SkillParseError::InvalidFormat(
                        "Field 'arguments' must contain only strings".to_string(),
                    )
                })
            })
            .collect::<Result<Vec<_>, _>>()?,
        _ => {
            return Err(SkillParseError::InvalidFormat(
                "Field 'arguments' must be a string or string list".to_string(),
            ));
        }
    };
    if names.len() > CLAUDE_ARGUMENT_NAMES_MAX {
        return Err(SkillParseError::InvalidFormat(format!(
            "Field 'arguments' cannot contain more than {CLAUDE_ARGUMENT_NAMES_MAX} names"
        )));
    }

    let mut seen = HashSet::with_capacity(names.len());
    for name in &names {
        let mut bytes = name.bytes();
        let Some(first) = bytes.next() else {
            return Err(SkillParseError::InvalidFormat(
                "Field 'arguments' contains an empty name".to_string(),
            ));
        };
        if name.len() > 64
            || !(first.is_ascii_alphabetic() || first == b'_')
            || !bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        {
            return Err(SkillParseError::InvalidFormat(format!(
                "Invalid argument name '{name}'"
            )));
        }
        if !seen.insert(name.as_str()) {
            return Err(SkillParseError::InvalidFormat(format!(
                "Duplicate argument name '{name}'"
            )));
        }
    }
    Ok(names)
}

fn claude_compatibility_warnings(
    metadata: &Value,
    body: &str,
) -> Result<Vec<String>, SkillParseError> {
    const UNSUPPORTED_FIELDS: &[&str] = &[
        "context",
        "agent",
        "paths",
        "shell",
        "runtime",
        "background",
        "disallowed-tools",
    ];
    if let Some(field) = UNSUPPORTED_FIELDS
        .iter()
        .find(|field| metadata.get(**field).is_some())
    {
        return Err(SkillParseError::UnsupportedClaudeField(
            (*field).to_string(),
        ));
    }

    let mut warnings = Vec::new();
    for field in ["model", "effort"] {
        if metadata.get(field).is_some() {
            warnings.push(format!(
                "Claude preference '{field}' is not applied; the current session configuration is used."
            ));
        }
    }
    const DYNAMIC_MARKERS: &[&str] = &[
        "${CLAUDE_SESSION_ID}",
        "${CLAUDE_EFFORT}",
        "${CLAUDE_SKILL_DIR}",
        "${CLAUDE_PROJECT_DIR}",
    ];
    for marker in DYNAMIC_MARKERS {
        if body.contains(marker) {
            warnings.push(format!(
                "Claude variable '{marker}' is preserved as literal text and has not been expanded. Do not assume it identifies a valid value or path."
            ));
        }
    }
    if has_claude_shell_expression(body) {
        warnings.push(
            "Claude shell expressions are preserved as literal text and have not been executed. They are not command results. If the task needs this data, obtain it through normal tools and permission checks in the active workspace.".to_string(),
        );
    }
    Ok(warnings)
}

fn has_claude_shell_expression(body: &str) -> bool {
    // Inline commands require a whitespace/start boundary and a closing backtick.
    // In particular, Markdown code such as `!` and `#REF!` is ordinary text.
    static INLINE: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        Regex::new(r"(?m)(?:^|\s)!`[^`\r\n]+`").expect("Claude inline expression regex")
    });
    static FENCED: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        Regex::new(r"(?m)^ {0,3}```![ \t]*\r?$").expect("Claude fenced expression regex")
    });
    INLINE.is_match(body) || FENCED.is_match(body)
}

impl SkillData {
    pub fn from_markdown(
        path: String,
        content: &str,
        location: SkillLocation,
        with_content: bool,
    ) -> Result<Self, SkillParseError> {
        Self::from_markdown_with_dialect(
            path,
            content,
            location,
            with_content,
            SkillSourceDialect::AgentSkills,
        )
    }

    pub fn from_markdown_for_source_slot(
        path: String,
        content: &str,
        location: SkillLocation,
        with_content: bool,
        source_slot: &str,
    ) -> Result<Self, SkillParseError> {
        Self::from_markdown_with_dialect(
            path,
            content,
            location,
            with_content,
            super::roots::skill_source_dialect(source_slot),
        )
    }

    fn from_markdown_with_dialect(
        path: String,
        content: &str,
        location: SkillLocation,
        with_content: bool,
        dialect: SkillSourceDialect,
    ) -> Result<Self, SkillParseError> {
        let (metadata, body) = parse_front_matter_markdown(content)?;
        let dir_name = directory_name(&path)?;

        let declared_name = metadata
            .get("name")
            .filter(|value| {
                dialect != SkillSourceDialect::Pi
                    || value.as_str().is_some_and(|name| !name.is_empty())
            })
            .map(|value| {
                value.as_str().map(str::to_string).ok_or_else(|| {
                    SkillParseError::InvalidFormat("Field 'name' must be a string".to_string())
                })
            })
            .transpose()?;
        let name = match dialect {
            SkillSourceDialect::ClaudeCode => dir_name.clone(),
            SkillSourceDialect::Codex | SkillSourceDialect::Pi => {
                declared_name.unwrap_or_else(|| dir_name.clone())
            }
            SkillSourceDialect::AgentSkills | SkillSourceDialect::DeepSeekHarness => {
                declared_name.ok_or(SkillParseError::MissingField("name"))?
            }
        };
        if dialect == SkillSourceDialect::DeepSeekHarness {
            if name.is_empty()
                || name.split('-').any(|part| {
                    part.is_empty()
                        || !part
                            .chars()
                            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit())
                })
            {
                return Err(SkillParseError::InvalidFormat(
                    "DeepSeek Harness skill names must use lowercase kebab-case".into(),
                ));
            }
            if ["disableModelInvocation", "modelInvocable", "userInvocable"]
                .iter()
                .any(|key| metadata.get(*key).is_some())
            {
                return Err(SkillParseError::InvalidFormat(
                    "DeepSeek Harness requires canonical invocation metadata keys".into(),
                ));
            }
        }

        let description = if dialect == SkillSourceDialect::ClaudeCode {
            claude_description(&metadata, &body)?
        } else {
            metadata
                .get("description")
                .and_then(|value| value.as_str())
                .map(str::to_string)
                .ok_or(SkillParseError::MissingField("description"))?
        };
        if matches!(
            dialect,
            SkillSourceDialect::Pi | SkillSourceDialect::DeepSeekHarness
        ) && description.trim().is_empty()
        {
            return Err(SkillParseError::MissingField("description"));
        }
        let (argument_names, compatibility_warnings) = if dialect == SkillSourceDialect::ClaudeCode
        {
            let warnings = claude_compatibility_warnings(&metadata, &body)?;
            (claude_argument_names(&metadata)?, warnings)
        } else {
            (Vec::new(), Vec::new())
        };

        let allow_implicit_invocation =
            !optional_claude_bool(&metadata, "disable-model-invocation")?.unwrap_or(false);
        let allow_user_invocation =
            optional_claude_bool(&metadata, "user-invocable")?.unwrap_or(true);
        let argument_hint = optional_string(&metadata, "argument-hint")?;

        let skill_content = if with_content { body } else { String::new() };
        let hooks = if dialect == SkillSourceDialect::ClaudeCode {
            metadata
                .get("hooks")
                .map(super::SkillHooks::from_yaml)
                .transpose()?
        } else {
            None
        };
        Ok(SkillData {
            key: String::new(),
            name,
            description,
            content: skill_content,
            location,
            path,
            entry_file: None,
            source_slot: String::new(),
            source_id: String::new(),
            source_label: String::new(),
            dir_name,
            allow_implicit_invocation,
            allow_user_invocation,
            argument_hint,
            argument_names,
            compatibility_warnings,
            hooks,
        })
    }

    pub fn apply_openai_yaml_policy(&mut self, content: &str) -> Result<(), SkillParseError> {
        let metadata: Value = serde_yaml::from_str(content).map_err(|error| {
            SkillParseError::InvalidFormat(format!("Failed to parse agents/openai.yaml: {error}"))
        })?;
        let Some(policy) = metadata.get("policy") else {
            return Ok(());
        };
        if !policy.is_mapping() {
            return Err(SkillParseError::InvalidFormat(
                "Field 'policy' in agents/openai.yaml must be a mapping".to_string(),
            ));
        }
        let Some(allow_implicit_invocation) = optional_bool(policy, "allow_implicit_invocation")?
        else {
            return Ok(());
        };

        self.allow_implicit_invocation &= allow_implicit_invocation;
        Ok(())
    }
}

pub fn render_loaded_skill_for_assistant(
    skill_data: &SkillData,
    loaded_by_stable_key: bool,
) -> String {
    let loaded_from = if loaded_by_stable_key {
        format!(" from stable key '{}'", skill_data.key)
    } else {
        String::new()
    };

    let warnings = if skill_data.compatibility_warnings.is_empty() {
        String::new()
    } else {
        format!(
            "\n\nCompatibility notes:\n- {}",
            skill_data.compatibility_warnings.join("\n- ")
        )
    };
    format!(
        "Skill '{}' loaded successfully{}. Note: any paths mentioned in this skill are relative to {}, not the workspace.{}\n\n<skill_content>\n{}\n</skill_content>",
        skill_data.name, loaded_from, skill_data.path, warnings, skill_data.content
    )
}
