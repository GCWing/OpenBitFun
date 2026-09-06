//! Playbook tool — predefined step-by-step operation guides for common tasks.
//!
//! A Playbook is a YAML-defined sequence of ControlHub actions with parameter
//! templates. The agent selects a playbook, fills in parameters, and the tool
//! returns the resolved step list for the agent to execute sequentially via
//! ControlHub.

use crate::agentic::tools::framework::{
    Tool, ToolExposure, ToolRenderOptions, ToolResult, ToolUseContext, ValidationResult,
};
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use async_trait::async_trait;
use include_dir::{include_dir, Dir};
use log::{debug, info};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;

/// Embedded playbook YAML files from `builtin_playbooks/`.
static BUILTIN_PLAYBOOKS_DIR: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/builtin_playbooks");

/// A parsed playbook definition.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaybookDef {
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub parameters: Vec<PlaybookParam>,
    pub steps: Vec<PlaybookStep>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaybookParam {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub default: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaybookStep {
    pub domain: String,
    pub action: String,
    #[serde(default)]
    pub params: Option<Value>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub output_var: Option<String>,
    #[serde(default)]
    pub condition: Option<String>,
}

pub struct PlaybookTool {
    playbooks: Vec<PlaybookDef>,
}

impl Default for PlaybookTool {
    fn default() -> Self {
        Self::new()
    }
}

impl PlaybookTool {
    pub fn new() -> Self {
        let mut playbooks = Vec::new();
        for entry in BUILTIN_PLAYBOOKS_DIR.files() {
            if let Some(ext) = entry.path().extension() {
                if ext == "yaml" || ext == "yml" {
                    if let Some(contents) = entry.contents_utf8() {
                        match serde_yaml::from_str::<PlaybookDef>(contents) {
                            Ok(pb) => {
                                debug!("Loaded builtin playbook: {}", pb.name);
                                playbooks.push(pb);
                            }
                            Err(e) => {
                                log::warn!(
                                    "Failed to parse playbook {}: {}",
                                    entry.path().display(),
                                    e
                                );
                            }
                        }
                    }
                }
            }
        }
        info!(
            "PlaybookTool initialized with {} builtin playbooks",
            playbooks.len()
        );
        Self { playbooks }
    }

    fn find_playbook(&self, name: &str) -> Option<&PlaybookDef> {
        self.playbooks.iter().find(|pb| pb.name == name)
    }

    /// Resolve template variables `{{var}}` in a JSON value.
    ///
    /// When a string value is *exactly* `"{{var}}"` (no surrounding text),
    /// the replacement attempts to preserve the variable's native type
    /// (integer, float, boolean) instead of always producing a string.
    fn resolve_templates(value: &Value, vars: &HashMap<String, String>) -> Value {
        match value {
            Value::String(s) => {
                let trimmed = s.trim();
                // Fast path: entire value is a single `{{var}}` — try typed replacement
                if trimmed.starts_with("{{")
                    && trimmed.ends_with("}}")
                    && trimmed.matches("{{").count() == 1
                {
                    let key = &trimmed[2..trimmed.len() - 2];
                    if let Some(val) = vars.get(key) {
                        return Self::parse_typed_value(val);
                    }
                }
                // General path: replace all occurrences, result is always a string
                let mut result = s.clone();
                for (key, val) in vars {
                    result = result.replace(&format!("{{{{{}}}}}", key), val);
                }
                Value::String(result)
            }
            Value::Object(map) => {
                let resolved: serde_json::Map<String, Value> = map
                    .iter()
                    .map(|(k, v)| (k.clone(), Self::resolve_templates(v, vars)))
                    .collect();
                Value::Object(resolved)
            }
            Value::Array(arr) => Value::Array(
                arr.iter()
                    .map(|v| Self::resolve_templates(v, vars))
                    .collect(),
            ),
            other => other.clone(),
        }
    }

    /// Try to parse a string as a native JSON type (number / bool), falling
    /// back to a JSON string.
    fn parse_typed_value(s: &str) -> Value {
        if let Ok(value) = serde_json::from_str::<Value>(s) {
            if value.is_array() || value.is_object() || value.is_null() {
                return value;
            }
        }
        if let Ok(n) = s.parse::<u64>() {
            return json!(n);
        }
        if let Ok(n) = s.parse::<i64>() {
            return json!(n);
        }
        if let Ok(n) = s.parse::<f64>() {
            return json!(n);
        }
        match s {
            "true" => json!(true),
            "false" => json!(false),
            _ => json!(s),
        }
    }

    /// Evaluate a step condition against the current parameter values.
    ///
    /// Supported syntax:
    /// - `"param_name is value"` → true when `vars[param_name] == value`
    /// - `"param_name is not value"` → true when `vars[param_name] != value`
    /// - `"param_name is provided"` → true when `vars[param_name]` exists and is non-empty
    /// - `None` / empty → always true (unconditional step)
    fn evaluate_condition(condition: &Option<String>, vars: &HashMap<String, String>) -> bool {
        let cond = match condition {
            Some(c) if !c.trim().is_empty() => c.trim(),
            _ => return true,
        };

        // "X is provided"
        if let Some(param) = cond.strip_suffix(" is provided") {
            let param = param.trim();
            return vars.get(param).map(|v| !v.is_empty()).unwrap_or(false);
        }

        // "X is not Y"
        if let Some(rest) = cond.strip_prefix("") {
            if let Some(pos) = rest.find(" is not ") {
                let param = rest[..pos].trim();
                let expected = rest[pos + 8..].trim();
                return vars.get(param).map(|v| v != expected).unwrap_or(true);
            }
        }

        // "X is Y"
        if let Some(pos) = cond.find(" is ") {
            let param = cond[..pos].trim();
            let expected = cond[pos + 4..].trim();
            return vars.get(param).map(|v| v == expected).unwrap_or(false);
        }

        // Unknown syntax — include step (let agent handle it)
        true
    }

    fn build_playbook_list_description(&self) -> String {
        if self.playbooks.is_empty() {
            return "No playbooks available.".to_string();
        }
        self.playbooks
            .iter()
            .map(|pb| {
                let params_desc = if pb.parameters.is_empty() {
                    "no parameters".to_string()
                } else {
                    pb.parameters
                        .iter()
                        .map(|p| {
                            let req = if p.required { " (required)" } else { "" };
                            format!("{}{}", p.name, req)
                        })
                        .collect::<Vec<_>>()
                        .join(", ")
                };
                format!(
                    "- **{}**: {} [params: {}]",
                    pb.name, pb.description, params_desc
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}

#[async_trait]
impl Tool for PlaybookTool {
    fn name(&self) -> &str {
        "Playbook"
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        let list = self.build_playbook_list_description();
        Ok(format!(
            r#"Execute a predefined operation playbook for common tasks.

A playbook is a step-by-step guide that tells you exactly which ControlHub actions to execute.
Use this tool when you recognize a common task pattern — it saves planning time and ensures correct execution order.

## How to use
1. Call Playbook with the playbook `name` and required `params`.
2. The tool returns a list of ControlHub steps with resolved parameters.
3. Execute each step sequentially using the ControlHub tool.
4. If a step fails or the page state differs from expectations, adapt accordingly.

## Actions
- **run**: Execute a playbook. Requires: `name`. Optional: `params` (object with parameter values).
- **list**: List all available playbooks and their parameters.

## Available Playbooks
{}"#,
            list
        ))
    }

    fn short_description(&self) -> String {
        "Get predefined step-by-step operation guides for common tasks.".to_string()
    }

    fn default_exposure(&self) -> ToolExposure {
        ToolExposure::Deferred
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["run", "list"],
                    "description": "Action: 'run' a playbook or 'list' all available playbooks."
                },
                "name": {
                    "type": "string",
                    "description": "Playbook name to execute (for 'run' action)."
                },
                "params": {
                    "type": "object",
                    "description": "Parameter values for the playbook template variables.",
                    "additionalProperties": true
                }
            },
            "required": ["action"]
        })
    }

    fn is_readonly(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: Option<&Value>) -> bool {
        true
    }

    async fn validate_input(
        &self,
        input: &Value,
        _context: Option<&ToolUseContext>,
    ) -> ValidationResult {
        let action = input.get("action").and_then(|v| v.as_str());
        if action.is_none() {
            return ValidationResult {
                result: false,
                message: Some("Missing required field: action".into()),
                error_code: None,
                meta: None,
            };
        }
        if action == Some("run") && input.get("name").and_then(|v| v.as_str()).is_none() {
            return ValidationResult {
                result: false,
                message: Some("'run' action requires 'name' field".into()),
                error_code: None,
                meta: None,
            };
        }
        ValidationResult::default()
    }

    fn render_tool_use_message(&self, input: &Value, _options: &ToolRenderOptions) -> String {
        let action = input.get("action").and_then(|v| v.as_str()).unwrap_or("?");
        let name = input.get("name").and_then(|v| v.as_str()).unwrap_or("");
        if name.is_empty() {
            format!("Playbook: {}", action)
        } else {
            format!("Playbook: {} ({})", action, name)
        }
    }

    fn render_result_for_assistant(&self, output: &Value) -> String {
        if let Some(steps) = output.get("steps").and_then(|v| v.as_array()) {
            let step_lines: Vec<String> = steps
                .iter()
                .enumerate()
                .map(|(i, s)| {
                    let domain = s.get("domain").and_then(|v| v.as_str()).unwrap_or("?");
                    let action = s.get("action").and_then(|v| v.as_str()).unwrap_or("?");
                    let desc = s.get("description").and_then(|v| v.as_str()).unwrap_or("");
                    if desc.is_empty() {
                        format!(
                            "{}. ControlHub {{ domain: \"{}\", action: \"{}\" }}",
                            i + 1,
                            domain,
                            action
                        )
                    } else {
                        format!(
                            "{}. {} — ControlHub {{ domain: \"{}\", action: \"{}\" }}",
                            i + 1,
                            desc,
                            domain,
                            action
                        )
                    }
                })
                .collect();
            return format!(
                "Execute these steps sequentially using ControlHub:\n{}",
                step_lines.join("\n")
            );
        }
        output.to_string()
    }

    async fn call_impl(
        &self,
        input: &Value,
        _context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let action = input
            .get("action")
            .and_then(|v| v.as_str())
            .ok_or_else(|| OpenBitFunError::tool("Missing 'action'".to_string()))?;

        match action {
            "list" => {
                let playbooks: Vec<Value> = self
                    .playbooks
                    .iter()
                    .map(|pb| {
                        json!({
                            "name": pb.name,
                            "description": pb.description,
                            "parameters": pb.parameters.iter().map(|p| json!({
                                "name": p.name,
                                "required": p.required,
                                "description": p.description,
                                "default": p.default,
                            })).collect::<Vec<_>>(),
                            "step_count": pb.steps.len(),
                        })
                    })
                    .collect();
                Ok(vec![ToolResult::ok(
                    json!({ "playbooks": playbooks }),
                    Some(self.build_playbook_list_description()),
                )])
            }
            "run" => {
                let name = input
                    .get("name")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| OpenBitFunError::tool("'run' requires 'name'".to_string()))?;

                let pb = self.find_playbook(name).ok_or_else(|| {
                    let available: Vec<&str> =
                        self.playbooks.iter().map(|p| p.name.as_str()).collect();
                    OpenBitFunError::tool(format!(
                        "Playbook '{}' not found. Available: {:?}",
                        name, available
                    ))
                })?;

                // Build variable map from params + defaults
                let mut vars: HashMap<String, String> = HashMap::new();
                for param in &pb.parameters {
                    if let Some(default) = &param.default {
                        vars.insert(param.name.clone(), default.clone());
                    }
                }
                if let Some(params_obj) = input.get("params").and_then(|v| v.as_object()) {
                    for (k, v) in params_obj {
                        let val = v
                            .as_str()
                            .map(|s| s.to_string())
                            .unwrap_or_else(|| v.to_string());
                        vars.insert(k.clone(), val);
                    }
                }

                // Validate required params
                for param in &pb.parameters {
                    if param.required && !vars.contains_key(&param.name) {
                        return Err(OpenBitFunError::tool(format!(
                            "Playbook '{}' requires parameter '{}'",
                            name, param.name
                        )));
                    }
                }

                // Resolve steps, filtering by condition when evaluable
                let steps: Vec<Value> = pb
                    .steps
                    .iter()
                    .filter(|step| Self::evaluate_condition(&step.condition, &vars))
                    .map(|step| {
                        let resolved_params = step
                            .params
                            .as_ref()
                            .map(|p| Self::resolve_templates(p, &vars))
                            .unwrap_or(json!({}));
                        let mut step_json = json!({
                            "domain": step.domain,
                            "action": step.action,
                            "params": resolved_params,
                        });
                        if let Some(desc) = &step.description {
                            step_json["description"] = json!(desc);
                        }
                        if let Some(ov) = &step.output_var {
                            step_json["output_var"] = json!(ov);
                        }
                        step_json
                    })
                    .collect();

                info!("Playbook '{}' resolved with {} steps", name, steps.len());

                Ok(vec![ToolResult::ok(
                    json!({
                        "playbook": name,
                        "description": pb.description,
                        "steps": steps,
                    }),
                    None, // render_result_for_assistant handles this
                )])
            }
            other => Err(OpenBitFunError::tool(format!(
                "Unknown playbook action: '{}'. Use 'run' or 'list'.",
                other
            ))),
        }
    }
}
