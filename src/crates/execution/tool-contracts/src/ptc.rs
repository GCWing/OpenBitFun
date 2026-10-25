//! Provider-neutral contracts used by the PTC tool presentation mode.
//!
//! This module deliberately contains no process, model-provider, or product
//! runtime code.  It describes the stable tool snapshot that can be projected
//! into a TypeScript program before the program is executed by a host runtime.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const PTC_TOOL_PRESENTATION_CONTEXT_KEY: &str = "tool_presentation_mode";
pub const PTC_TOOL_PRESENTATION_MODE: &str = "ptc";
/// Serialized per-turn allowlist used by the PTC host for nested calls.
///
/// The model-facing manifest intentionally contains only `RunCode`, while
/// nested SDK calls must still use the Agent's original tool policy.
pub const PTC_NESTED_ALLOWED_TOOLS_CONTEXT_KEY: &str = "ptc_nested_allowed_tools";
pub const PTC_RUN_CODE_TOOL_NAME: &str = "RunCode";

/// A tool definition exposed to a PTC program.
///
/// `input_schema` and `output_schema` are JSON Schema values. `output_schema`
/// describes the compact assistant-facing projection of a tool result. It is
/// deliberately smaller than the canonical value when the latter contains
/// UI, diagnostics, persistence, or transport metadata; fields needed for
/// model control flow (such as cursors and operation ids) should still be
/// included. An empty output schema means that the tool has no stronger output
/// contract and projects to `unknown` in TypeScript.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtcToolContract {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    #[serde(default)]
    pub output_schema: Value,
    #[serde(default)]
    pub is_readonly: bool,
    #[serde(default)]
    pub is_concurrency_safe: bool,
    /// Deferred tools are listed by name and description, but their full
    /// schema is loaded through `tools.getToolSpec` at runtime.
    #[serde(default)]
    pub is_deferred: bool,
}

impl PtcToolContract {
    pub fn new(
        name: impl Into<String>,
        description: impl Into<String>,
        input_schema: Value,
        output_schema: Value,
    ) -> Self {
        Self {
            name: name.into(),
            description: description.into(),
            input_schema,
            output_schema,
            is_readonly: false,
            is_concurrency_safe: false,
            is_deferred: false,
        }
    }
}

/// The error shape returned by a failed nested tool call.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtcToolCallError {
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

/// Converts a JSON Schema value into a deterministic TypeScript type.
///
/// JSON Schema is larger than TypeScript's type system.  Unsupported or
/// ambiguous constructs intentionally degrade to `unknown`; runtime JSON
/// validation remains authoritative when the generated SDK is invoked.
pub fn json_schema_to_typescript(schema: &Value) -> String {
    schema_type(schema)
}

/// Render the type declarations used by the generated PTC SDK.
pub fn render_ptc_typescript_sdk(contracts: &[PtcToolContract]) -> String {
    render_ptc_typescript_sdk_with_options(contracts, true)
}

/// Render the generated PTC SDK, optionally exposing the APIs used to load and
/// invoke deferred tools by name.
pub fn render_ptc_typescript_sdk_with_options(
    contracts: &[PtcToolContract],
    include_deferred_tool_apis: bool,
) -> String {
    render_ptc_typescript_sdk_internal(
        contracts,
        include_deferred_tool_apis,
        true,
        include_deferred_tool_apis,
    )
}

/// Render the SDK returned after a deferred tool definition has been loaded.
///
/// The conversation reminder already explains the load workflow. This result
/// only needs the loaded tool's concrete types and the generic call API used
/// to invoke it.
pub fn render_ptc_loaded_tool_typescript_sdk(contract: &PtcToolContract) -> String {
    let mut contract = contract.clone();
    let call_hint = format!(
        "Invoke it with tools.callTool(\"{}\", args).",
        contract.name
    );
    contract.description = if contract.description.trim().is_empty() {
        call_hint
    } else {
        format!("{} {}", contract.description, call_hint)
    };
    render_ptc_typescript_sdk_internal(&[contract], false, false, true)
}

fn render_ptc_typescript_sdk_internal(
    contracts: &[PtcToolContract],
    include_deferred_tool_apis: bool,
    include_shared_types: bool,
    include_call_tool_api: bool,
) -> String {
    let mut output = String::new();
    if include_shared_types {
        output.push_str(
            "export type PtcToolCallError = { code: string; message: string; details?: unknown };\n\n",
        );
    }

    output.push_str("export type ToolArgsMap = {\n");
    for contract in contracts {
        let description = if contract.is_deferred {
            format!(
                "{} Deferred tool: load its definition with tools.getToolSpec(\"{}\") first, then invoke it with tools.callTool(\"{}\", args).",
                contract.description, contract.name, contract.name
            )
        } else {
            contract.description.clone()
        };
        output.push_str(&render_jsdoc(&description, "  "));
        output.push_str("  ");
        output.push_str(&typescript_property_key(&contract.name));
        output.push_str(": ");
        if contract.is_deferred {
            output.push_str("Record<string, unknown>");
        } else {
            output.push_str(&schema_type_with_docs(&contract.input_schema, 2));
        }
        output.push_str(";\n");
    }
    output.push_str("};\n\n");

    output.push_str("export type ToolOutputMap = {\n");
    for contract in contracts {
        output.push_str("  ");
        output.push_str(&typescript_property_key(&contract.name));
        output.push_str(": ");
        if contract.is_deferred {
            output.push_str("unknown");
        } else {
            output.push_str(&schema_type_with_docs(&contract.output_schema, 2));
        }
        output.push_str(";\n");
    }
    output.push_str("};\n\n");

    output.push_str("export type PtcToolBindings = {\n");
    for contract in contracts {
        if contract.is_deferred {
            output.push_str(
                "  /** Deferred tool placeholder. Load its schema with tools.getToolSpec and execute with tools.callTool; do not guess its arguments. */\n",
            );
        }
        output.push_str("  ");
        output.push_str(&typescript_property_key(&contract.name));
        output.push_str("(args: ToolArgsMap[");
        output.push_str(&json_string_literal(&contract.name));
        output.push_str("]): Promise<ToolOutputMap[");
        output.push_str(&json_string_literal(&contract.name));
        output.push_str("]>;\n");
    }
    if include_deferred_tool_apis {
        output
            .push_str("  /** Load a deferred tool definition into the current PTC operation. */\n");
        output.push_str("  getToolSpec(name: string): Promise<{ typescript_sdk: string }>;\n");
    }
    if include_call_tool_api {
        output
            .push_str("  /** Execute a tool by name with arguments matching its loaded SDK. */\n");
        output.push_str(
            "  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;\n",
        );
    }
    output.push_str("};\n\n");
    output.push_str("declare const tools: PtcToolBindings;\n");
    output
}

/// Input schema for the single model-visible PTC entrypoint.
pub fn ptc_run_code_input_schema() -> Value {
    serde_json::json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "code": {
                "type": "string",
                "description": "TypeScript program. Call tools by name through the generated tools binding and return a JSON value."
            },
            "timeout_ms": {
                "type": "integer",
                "minimum": 1,
                "description": "Optional positive execution deadline in milliseconds."
            }
        },
        "required": ["code"]
    })
}

pub fn ptc_run_code_description() -> String {
    "Execute a TypeScript program that can call available tools through the provided `tools` binding and return a compact JSON value."
        .to_string()
}

/// Render the PTC SDK as a conversation-start reminder instead of embedding
/// the large declaration block in the single `RunCode` tool description.
pub fn render_ptc_tool_calling_guide(sdk_source: &str) -> String {
    render_ptc_tool_calling_guide_with_options(sdk_source, true)
}

/// Render the PTC conversation-start guide with wording that matches the
/// capabilities exposed by the generated SDK.
pub fn render_ptc_tool_calling_guide_with_options(
    sdk_source: &str,
    include_deferred_tool_apis: bool,
) -> String {
    let deferred_guidance = if include_deferred_tool_apis {
        "\n\nFor deferred tools:\n1. Call `tools.getToolSpec(\"tool_name\")` before choosing arguments.\n2. Read the returned `typescript_sdk`, which contains the input and output types.\n3. Call `tools.callTool(\"tool_name\", args)` with arguments matching that SDK.\nDo not infer deferred tool arguments from the placeholder `Record<string, unknown>` type."
    } else {
        ""
    };
    format!(
        "# Tool Calling Guide\nUse `RunCode` with a TypeScript program. Call tools through the generated `tools` binding and return a JSON-serializable value. The binding includes direct tool signatures.{}\n\nGenerated SDK:\n```ts\n{}\n```",
        deferred_guidance,
        sdk_source.trim(),
    )
}

fn schema_type(schema: &Value) -> String {
    let Some(object) = schema.as_object() else {
        return "unknown".to_string();
    };

    if let Some(constant) = object.get("const") {
        return json_literal_type(constant);
    }

    if let Some(enum_values) = object.get("enum").and_then(Value::as_array) {
        if enum_values.is_empty() {
            return "never".to_string();
        }
        return enum_values
            .iter()
            .map(json_literal_type)
            .collect::<Vec<_>>()
            .join(" | ");
    }

    for key in ["oneOf", "anyOf"] {
        if let Some(variants) = object.get(key).and_then(Value::as_array) {
            if variants.is_empty() {
                return "unknown".to_string();
            }
            return variants
                .iter()
                .map(schema_type)
                .collect::<Vec<_>>()
                .join(" | ");
        }
    }

    if let Some(all_of) = object.get("allOf").and_then(Value::as_array) {
        if all_of.is_empty() {
            return "unknown".to_string();
        }
        return all_of
            .iter()
            .map(schema_type)
            .collect::<Vec<_>>()
            .join(" & ");
    }

    // JSON Schema also permits a type union in the compact `type: [...]`
    // form. Normalize each member through the same projector used by
    // `anyOf`, so nullable fields remain useful in the generated SDK.
    if let Some(types) = object.get("type").and_then(Value::as_array) {
        if types.is_empty() {
            return "unknown".to_string();
        }
        return types
            .iter()
            .map(|type_value| {
                let Some(type_name) = type_value.as_str() else {
                    return "unknown".to_string();
                };
                let mut variant = Map::new();
                variant.insert("type".to_string(), Value::String(type_name.to_string()));
                schema_type(&Value::Object(variant))
            })
            .collect::<Vec<_>>()
            .join(" | ");
    }

    match object.get("type").and_then(Value::as_str) {
        Some("null") => "null".to_string(),
        Some("boolean") => "boolean".to_string(),
        Some("integer") | Some("number") => "number".to_string(),
        Some("string") => "string".to_string(),
        Some("array") => object
            .get("items")
            .map(schema_type)
            .map(|item| format!("Array<{item}>"))
            .unwrap_or_else(|| "Array<unknown>".to_string()),
        Some("object") => object_type(object),
        Some("true") => "unknown".to_string(),
        Some("false") => "never".to_string(),
        _ => "unknown".to_string(),
    }
}

fn object_type(object: &Map<String, Value>) -> String {
    let Some(properties) = object.get("properties").and_then(Value::as_object) else {
        return object
            .get("additionalProperties")
            .map(|value| match value {
                Value::Bool(false) => "Record<string, never>".to_string(),
                Value::Bool(true) => "Record<string, unknown>".to_string(),
                _ => format!("Record<string, {}>", schema_type(value)),
            })
            .unwrap_or_else(|| "unknown".to_string());
    };

    if properties.is_empty() {
        return match object.get("additionalProperties") {
            Some(Value::Bool(false)) => "Record<string, never>".to_string(),
            Some(Value::Bool(true)) | None => "Record<string, unknown>".to_string(),
            Some(schema) => format!("Record<string, {}>", schema_type(schema)),
        };
    }

    let required = object
        .get("required")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .collect::<std::collections::BTreeSet<_>>()
        })
        .unwrap_or_default();

    let mut output = String::from("{ ");
    for (name, property) in properties {
        output.push_str(&quote_property_key(name));
        if !required.contains(name.as_str()) {
            output.push('?');
        }
        output.push_str(": ");
        output.push_str(&schema_type(property));
        output.push_str("; ");
    }
    if !matches!(object.get("additionalProperties"), Some(Value::Bool(false))) {
        output.push_str("[key: string]: unknown; ");
    }
    output.push('}');
    output
}

/// Render the same schema projection as [`json_schema_to_typescript`] while
/// retaining the descriptions that help a model call the generated SDK.
fn schema_type_with_docs(schema: &Value, indent: usize) -> String {
    let Some(object) = schema.as_object() else {
        return "unknown".to_string();
    };

    if let Some(constant) = object.get("const") {
        return json_literal_type(constant);
    }

    if let Some(enum_values) = object.get("enum").and_then(Value::as_array) {
        if enum_values.is_empty() {
            return "never".to_string();
        }
        return enum_values
            .iter()
            .map(json_literal_type)
            .collect::<Vec<_>>()
            .join(" | ");
    }

    for key in ["oneOf", "anyOf"] {
        if let Some(variants) = object.get(key).and_then(Value::as_array) {
            if variants.is_empty() {
                return "unknown".to_string();
            }
            return variants
                .iter()
                .map(|variant| schema_type_with_docs(variant, indent))
                .collect::<Vec<_>>()
                .join(" | ");
        }
    }

    if let Some(all_of) = object.get("allOf").and_then(Value::as_array) {
        if all_of.is_empty() {
            return "unknown".to_string();
        }
        return all_of
            .iter()
            .map(|variant| schema_type_with_docs(variant, indent))
            .collect::<Vec<_>>()
            .join(" & ");
    }

    match object.get("type").and_then(Value::as_str) {
        Some("array") => object
            .get("items")
            .map(|item| format!("Array<{}>", schema_type_with_docs(item, indent)))
            .unwrap_or_else(|| "Array<unknown>".to_string()),
        Some("object") => object_type_with_docs(object, indent),
        _ => schema_type(schema),
    }
}

fn object_type_with_docs(object: &Map<String, Value>, indent: usize) -> String {
    let Some(properties) = object.get("properties").and_then(Value::as_object) else {
        return object_type(object);
    };

    if properties.is_empty() {
        return object_type(object);
    }

    let required = object
        .get("required")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .collect::<std::collections::BTreeSet<_>>()
        })
        .unwrap_or_default();
    let property_indent = " ".repeat(indent + 2);
    let closing_indent = " ".repeat(indent);
    let mut output = String::from("{\n");

    for (name, property) in properties {
        if let Some(description) = property.get("description").and_then(Value::as_str) {
            output.push_str(&render_jsdoc(description, &property_indent));
        }
        output.push_str(&property_indent);
        output.push_str(&typescript_property_key(name));
        if !required.contains(name.as_str()) {
            output.push('?');
        }
        output.push_str(": ");
        output.push_str(&schema_type_with_docs(property, indent + 2));
        output.push_str(";\n");
    }

    if !matches!(object.get("additionalProperties"), Some(Value::Bool(false))) {
        output.push_str(&property_indent);
        output.push_str("[key: string]: unknown;\n");
    }
    output.push_str(&closing_indent);
    output.push('}');
    output
}

fn render_jsdoc(description: &str, indent: &str) -> String {
    let description = description
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .replace("*/", "* /");
    if description.is_empty() {
        return String::new();
    }
    format!("{indent}/** {description} */\n")
}

fn quote_property_key(value: &str) -> String {
    json_string_literal(value)
}

fn typescript_property_key(value: &str) -> String {
    if is_typescript_identifier(value) {
        value.to_string()
    } else {
        json_string_literal(value)
    }
}

fn is_typescript_identifier(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first == '_' || first == '$' || first.is_ascii_alphabetic())
        && chars.all(|character| {
            character == '_' || character == '$' || character.is_ascii_alphanumeric()
        })
}

fn json_string_literal(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

fn json_literal_type(value: &Value) -> String {
    match value {
        Value::String(_) => json_string_literal(value.as_str().unwrap_or_default()),
        Value::Number(number) => number.to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Null => "null".to_string(),
        Value::Array(_) | Value::Object(_) => "unknown".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        json_schema_to_typescript, ptc_run_code_description, ptc_run_code_input_schema,
        render_ptc_loaded_tool_typescript_sdk, render_ptc_tool_calling_guide,
        render_ptc_tool_calling_guide_with_options, render_ptc_typescript_sdk,
        render_ptc_typescript_sdk_with_options, PtcToolContract,
    };
    use serde_json::json;

    #[test]
    fn projects_object_schema_with_required_and_optional_properties() {
        let result = json_schema_to_typescript(&json!({
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "limit": {"type": "integer"}
            },
            "required": ["path"],
            "additionalProperties": false
        }));

        assert_eq!(result, "{ \"limit\"?: number; \"path\": string; }");
    }

    #[test]
    fn unsupported_schema_is_unknown_and_empty_output_is_open() {
        assert_eq!(json_schema_to_typescript(&json!({})), "unknown");
        assert_eq!(
            json_schema_to_typescript(&json!({"type": "array"})),
            "Array<unknown>"
        );
    }

    #[test]
    fn projects_json_schema_type_arrays_as_typescript_unions() {
        assert_eq!(
            json_schema_to_typescript(&json!({"type": ["integer", "null"]})),
            "number | null"
        );
    }

    #[test]
    fn sdk_quotes_arbitrary_tool_names_and_contains_input_and_output_maps() {
        let mut contract = PtcToolContract::new(
            "tool.with-dash",
            "demo",
            json!({"type": "object", "properties": {}, "additionalProperties": false}),
            json!({"type": "string"}),
        );
        contract.is_readonly = true;
        let output = render_ptc_typescript_sdk(&[contract]);

        assert!(output.contains("export type ToolArgsMap"));
        assert!(output.contains("\"tool.with-dash\": Record<string, never>;"));
        assert!(output.contains("\"tool.with-dash\": string;"));
        assert!(output.contains("Promise<ToolOutputMap[\"tool.with-dash\"]>"));
    }

    #[test]
    fn sdk_preserves_tool_and_parameter_descriptions_as_jsdoc() {
        let contract = PtcToolContract::new(
            "ask_user_question",
            "Ask the user a concise question when you need confirmation.",
            json!({
                "type": "object",
                "properties": {
                    "questions": {
                        "type": "array",
                        "description": "Questions to ask the user before continuing.",
                        "items": {"type": "string"}
                    },
                    "timeout_ms": {
                        "type": "integer",
                        "description": "Optional deadline in milliseconds."
                    }
                },
                "required": ["questions"],
                "additionalProperties": false
            }),
            json!({"type": "string", "description": "The user's answer."}),
        );

        let output = render_ptc_typescript_sdk(&[contract]);
        assert!(output.contains(
            "  /** Ask the user a concise question when you need confirmation. */\n  ask_user_question:"
        ));
        assert!(output.contains(
            "    /** Questions to ask the user before continuing. */\n    questions: Array<string>;"
        ));
        assert!(output
            .contains("    /** Optional deadline in milliseconds. */\n    timeout_ms?: number;"));
        assert_eq!(
            output
                .matches("/** Ask the user a concise question when you need confirmation. */")
                .count(),
            1
        );
        assert!(output.contains("  ask_user_question: string;"));
        assert!(output.contains("  ask_user_question(args: ToolArgsMap[\"ask_user_question\"]):"));
    }

    #[test]
    fn sdk_lists_deferred_tools_without_eager_schema_and_adds_lazy_apis() {
        let mut contract = PtcToolContract::new(
            "WebFetch",
            "Fetch a web page.",
            json!({"type": "object", "properties": {"url": {"type": "string"}}}),
            json!({"type": "object", "properties": {"content": {"type": "string"}}}),
        );
        contract.is_deferred = true;

        let output = render_ptc_typescript_sdk(&[contract]);
        assert!(output.contains("WebFetch: Record<string, unknown>;"));
        assert!(output.contains("WebFetch: unknown;"));
        assert!(output.contains("getToolSpec(name: string)"));
        assert!(output.contains("Promise<{ typescript_sdk: string }>"));
        assert!(!output.contains("input_schema: unknown"));
        assert!(output.contains("callTool(name: string, args: Record<string, unknown>)"));
        assert!(!output.contains("url: string"));
        assert!(!output.contains("Deferred tool workflow:"));
        assert!(
            !output.contains("Call tools.getToolSpec(\"tool_name\") before choosing arguments.")
        );
        assert!(output.contains(
            "Deferred tool: load its definition with tools.getToolSpec(\"WebFetch\") first"
        ));
        assert!(output.contains(
            "Deferred tool placeholder. Load its schema with tools.getToolSpec and execute with tools.callTool"
        ));

        let guide = render_ptc_tool_calling_guide_with_options(&output, true);
        assert!(guide.contains("For deferred tools:"));
        assert!(
            guide.contains("Call `tools.getToolSpec(\"tool_name\")` before choosing arguments.")
        );
        assert!(guide.contains("Read the returned `typescript_sdk`"));
        assert!(guide.contains("Call `tools.callTool(\"tool_name\", args)`"));
        assert!(guide.contains("Do not infer deferred tool arguments"));
    }

    #[test]
    fn loaded_tool_sdk_keeps_only_call_guidance_and_concrete_types() {
        let contract = PtcToolContract::new(
            "WebFetch",
            "Fetch a web page.",
            json!({"type": "object", "properties": {"url": {"type": "string"}}}),
            json!({"type": "object", "properties": {"content": {"type": "string"}}}),
        );

        let output = render_ptc_loaded_tool_typescript_sdk(&contract);
        assert!(!output.contains("PtcToolCallError"));
        assert!(!output.contains("Deferred tool workflow:"));
        assert!(!output.contains("getToolSpec(name: string)"));
        assert!(output.contains("callTool(name: string, args: Record<string, unknown>)"));
        assert!(output.contains("Invoke it with tools.callTool(\"WebFetch\", args)."));
        assert!(output.contains("url?: string"));
        assert!(output.contains("content?: string"));
    }

    #[test]
    fn sdk_can_omit_deferred_tool_apis_when_loading_is_disabled() {
        let output = render_ptc_typescript_sdk_with_options(&[], false);
        assert!(!output.contains("getToolSpec(name: string)"));
        assert!(!output.contains("callTool(name: string, args: Record<string, unknown>)"));

        let guide = render_ptc_tool_calling_guide_with_options(&output, false);
        assert!(guide.contains("The binding includes direct tool signatures."));
        assert!(!guide.contains("deferred tools"));
    }

    #[test]
    fn run_code_schema_requires_code_and_description_points_to_guide() {
        let schema = ptc_run_code_input_schema();
        assert_eq!(schema["required"], json!(["code"]));
        assert_eq!(schema["properties"]["code"]["type"], "string");
        let description = ptc_run_code_description();
        assert!(description.contains("TypeScript program"));
        assert!(description.contains("provided `tools` binding"));
        assert!(description.contains("compact JSON value"));
        assert!(!description.contains("Tool Calling Guide"));
        assert!(!description.contains("permission"));
        assert!(!description.contains("remote-routing"));
        assert!(
            render_ptc_tool_calling_guide("export type ToolArgsMap = {};").contains("ToolArgsMap")
        );
    }
}
