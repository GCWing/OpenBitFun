//! Provider-neutral contracts used by the PTC tool presentation mode.
//!
//! This module deliberately contains no process, model-provider, or product
//! runtime code.  It describes the stable tool snapshot that can be projected
//! into the selected PTC source language before the program is executed by a
//! host runtime.

use openbitfun_core_types::PtcLanguage;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const PTC_TOOL_PRESENTATION_CONTEXT_KEY: &str = "tool_presentation_mode";
pub const PTC_TOOL_PRESENTATION_MODE: &str = "ptc";
pub const PTC_LANGUAGE_CONTEXT_KEY: &str = "ptc_language";
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

/// Render the SDK for the selected PTC source language.
pub fn render_ptc_sdk(contracts: &[PtcToolContract], language: PtcLanguage) -> String {
    render_ptc_sdk_with_options(contracts, language, true)
}

/// Render the SDK while controlling whether deferred loading APIs are exposed.
/// When deferred loading is disabled, the model should not be told about APIs
/// that the host will reject.
pub fn render_ptc_sdk_with_options(
    contracts: &[PtcToolContract],
    language: PtcLanguage,
    include_deferred_tool_apis: bool,
) -> String {
    match language {
        PtcLanguage::TypeScript => {
            render_ptc_typescript_sdk_with_options(contracts, include_deferred_tool_apis)
        }
        PtcLanguage::Python => render_ptc_python_sdk(
            contracts,
            include_deferred_tool_apis,
            include_deferred_tool_apis,
        ),
    }
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

/// Render a loaded-tool SDK in the selected language.
pub fn render_ptc_loaded_tool_sdk(contract: &PtcToolContract, language: PtcLanguage) -> String {
    match language {
        PtcLanguage::TypeScript => render_ptc_loaded_tool_typescript_sdk(contract),
        PtcLanguage::Python => render_ptc_python_sdk(std::slice::from_ref(contract), false, true),
    }
}

fn render_ptc_python_sdk(
    contracts: &[PtcToolContract],
    include_deferred_apis: bool,
    include_call_tool_api: bool,
) -> String {
    let mut output = String::from(
        "from typing import Any, Literal, NotRequired, Protocol, Required, TypedDict, Union\n\n",
    );
    if include_deferred_apis {
        output.push_str(
            "PtcToolSpec = TypedDict(\n    \"PtcToolSpec\",\n    {\n        \"language\": Required[str],\n        \"sdk_source\": Required[str],\n    },\n)\n\n",
        );
    }
    let mut methods = Vec::new();
    for contract in contracts {
        if contract.is_deferred {
            continue;
        }
        if !is_python_identifier(&contract.name) {
            continue;
        }
        let args_alias = python_alias_name(&contract.name, "Args");
        let output_alias = python_alias_name(&contract.name, "Output");
        render_python_schema_alias(&mut output, &args_alias, &contract.input_schema);
        render_python_schema_alias(&mut output, &output_alias, &contract.output_schema);
        methods.push((contract, args_alias, output_alias));
    }

    output.push_str("\nclass PtcToolBindings(Protocol):\n");
    for contract in contracts {
        if contract.is_deferred {
            output.push_str("    # Deferred tool: ");
            output.push_str(&contract.name);
            output.push_str(
                ". Load its SDK with tools.get_tool_spec before calling tools.call_tool.\n",
            );
            continue;
        }
        let Some((_, args_alias, output_alias)) = methods
            .iter()
            .find(|(method, _, _)| method.name == contract.name)
        else {
            continue;
        };
        if !contract.description.trim().is_empty() {
            for line in contract.description.lines() {
                output.push_str("    # ");
                output.push_str(line.trim());
                output.push('\n');
            }
        }
        output.push_str("    async def ");
        output.push_str(&contract.name);
        output.push_str("(self, args: ");
        output.push_str(args_alias);
        output.push_str(") -> ");
        output.push_str(output_alias);
        output.push_str(": ...\n");
    }
    if methods.is_empty() {
        output.push_str("    pass\n");
    }
    if include_deferred_apis {
        output.push_str("\n    async def get_tool_spec(self, name: str) -> PtcToolSpec: ...\n");
    }
    if include_call_tool_api {
        output.push_str(
            "    async def call_tool(self, name: str, args: dict[str, Any]) -> Any: ...\n",
        );
    }
    if include_deferred_apis {
        output.push_str(
            "\n# Deferred tools: await tools.get_tool_spec(\"name\"), then await tools.call_tool(\"name\", args).\n",
        );
    }
    output.push_str("\ntools: PtcToolBindings\n");
    output
}

fn python_alias_name(tool_name: &str, suffix: &str) -> String {
    let mut name = tool_name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '_' {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    if name.is_empty() {
        name.push_str("Tool");
    }
    if name
        .chars()
        .next()
        .is_some_and(|character| character.is_ascii_digit())
    {
        name.insert(0, '_');
    }
    name.push_str(suffix);
    name
}

fn render_python_schema_alias(output: &mut String, alias: &str, schema: &Value) {
    let mut aliases = Vec::new();
    let type_name = python_type_with_aliases(schema, alias, &mut aliases);
    for definition in aliases {
        output.push_str(&definition);
    }
    if type_name != alias {
        output.push_str(alias);
        output.push_str(" = ");
        output.push_str(&type_name);
        output.push_str("\n\n");
    }
}

fn python_type_with_aliases(schema: &Value, alias: &str, aliases: &mut Vec<String>) -> String {
    let Some(object) = schema.as_object() else {
        return "Any".to_string();
    };
    if let Some(constant) = object.get("const") {
        return format!("Literal[{}]", python_literal(constant));
    }
    if let Some(values) = object.get("enum").and_then(Value::as_array) {
        if values.is_empty() {
            return "Any".to_string();
        }
        return format!(
            "Literal[{}]",
            values
                .iter()
                .map(python_literal)
                .collect::<Vec<_>>()
                .join(", ")
        );
    }
    for key in ["oneOf", "anyOf"] {
        if let Some(variants) = object.get(key).and_then(Value::as_array) {
            if variants.is_empty() {
                return "Any".to_string();
            }
            return format!(
                "Union[{}]",
                variants
                    .iter()
                    .enumerate()
                    .map(|(index, variant)| {
                        python_type_with_aliases(
                            variant,
                            &format!("{alias}Variant{}", index + 1),
                            aliases,
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(", ")
            );
        }
    }
    if let Some(types) = object.get("type").and_then(Value::as_array) {
        return format!(
            "Union[{}]",
            types
                .iter()
                .filter_map(Value::as_str)
                .enumerate()
                .map(|(index, type_name)| {
                    python_type_with_aliases(
                        &serde_json::json!({"type": type_name}),
                        &format!("{alias}Variant{}", index + 1),
                        aliases,
                    )
                })
                .collect::<Vec<_>>()
                .join(", ")
        );
    }
    if object.contains_key("properties") || object.contains_key("additionalProperties") {
        return python_object_type(object, alias, aliases);
    }
    match object.get("type").and_then(Value::as_str) {
        Some("null") => "None".to_string(),
        Some("boolean") => "bool".to_string(),
        Some("integer") => "int".to_string(),
        Some("number") => "float".to_string(),
        Some("string") => "str".to_string(),
        Some("array") => format!(
            "list[{}]",
            object
                .get("items")
                .map(|item| python_type_with_aliases(item, &format!("{alias}Item"), aliases))
                .unwrap_or_else(|| "Any".to_string())
        ),
        Some("object") => python_object_type(object, alias, aliases),
        _ => "Any".to_string(),
    }
}

fn python_object_type(
    object: &Map<String, Value>,
    alias: &str,
    aliases: &mut Vec<String>,
) -> String {
    let Some(properties) = object.get("properties").and_then(Value::as_object) else {
        return python_additional_properties_type(object, alias, aliases);
    };
    if properties.is_empty() {
        return python_additional_properties_type(object, alias, aliases);
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
    let mut definition = String::new();
    definition.push_str(alias);
    definition.push_str(" = TypedDict(\n    \"");
    definition.push_str(alias);
    definition.push_str("\",\n    {\n");
    let mut fields = Vec::new();
    for (name, property) in properties {
        let child_alias = format!("{}{}", alias, python_alias_component(name));
        let property_type = python_type_with_aliases(property, &child_alias, aliases);
        fields.push((
            name,
            property_type,
            required.contains(name.as_str()),
            property,
        ));
    }
    for (name, property_type, is_required, property) in fields {
        if let Some(description) = property.get("description").and_then(Value::as_str) {
            for line in description.lines() {
                definition.push_str("        # ");
                definition.push_str(line.trim());
                definition.push('\n');
            }
        }
        definition.push_str("        ");
        definition.push_str(&python_string_literal(name));
        definition.push_str(": ");
        definition.push_str(if is_required {
            "Required["
        } else {
            "NotRequired["
        });
        definition.push_str(&property_type);
        definition.push_str("],\n");
    }
    definition.push_str("    },\n)\n\n");
    aliases.push(definition);
    alias.to_string()
}

fn python_additional_properties_type(
    object: &Map<String, Value>,
    alias: &str,
    aliases: &mut Vec<String>,
) -> String {
    match object.get("additionalProperties") {
        Some(Value::Bool(false)) => "dict[str, Any]".to_string(),
        Some(Value::Bool(true)) | None => "dict[str, Any]".to_string(),
        Some(schema) => format!(
            "dict[str, {}]",
            python_type_with_aliases(schema, &format!("{alias}Value"), aliases)
        ),
    }
}

fn python_alias_component(value: &str) -> String {
    let mut component = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '_' {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    if component.is_empty() {
        component.push_str("Field");
    }
    if component
        .chars()
        .next()
        .is_some_and(|character| character.is_ascii_digit())
    {
        component.insert(0, '_');
    }
    component[0..1].to_ascii_uppercase() + &component[1..]
}

fn python_string_literal(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

fn python_literal(value: &Value) -> String {
    match value {
        Value::Null => "None".to_string(),
        Value::Bool(value) => {
            if *value {
                "True".to_string()
            } else {
                "False".to_string()
            }
        }
        Value::Number(value) => value.to_string(),
        Value::String(value) => python_string_literal(value),
        Value::Array(_) | Value::Object(_) => "Any".to_string(),
    }
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
        output.push_str(
            "  getToolSpec(name: string): Promise<{ language: string; sdk_source: string }>;\n",
        );
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

pub fn ptc_run_code_input_schema_for_language(language: PtcLanguage) -> Value {
    let mut schema = ptc_run_code_input_schema();
    let description = match language {
        PtcLanguage::TypeScript => {
            "TypeScript program. Call tools through the generated tools binding and return a JSON value."
        }
        PtcLanguage::Python => {
            "Python source code executed inside an existing async function. Use top-level `await`; do not call `asyncio.run`."
        }
    };
    if let Some(code) = schema
        .get_mut("properties")
        .and_then(Value::as_object_mut)
        .and_then(|properties| properties.get_mut("code"))
    {
        code["description"] = Value::String(description.to_string());
    }
    schema
}

pub fn ptc_run_code_description() -> String {
    "Execute a TypeScript program that can call available tools through the provided `tools` binding and return a compact JSON value."
        .to_string()
}

pub fn ptc_run_code_description_for_language(language: PtcLanguage) -> String {
    match language {
        PtcLanguage::TypeScript => ptc_run_code_description(),
        PtcLanguage::Python => {
            "Execute a Python program that can call available tools through the provided `tools` binding and return a compact JSON value. The program runs inside an existing async event loop, so use top-level `await` and do not call `asyncio.run`. Use Python syntax only. Do not emit TypeScript/JavaScript syntax such as `const`, `let`, `Promise`, or `=>`. The runtime has already imported and bound `asyncio` and `json` in the execution scope, so use them directly. Do not import other modules, including `os`, `pathlib`, `subprocess`, `requests`, and similar modules.".to_string()
        }
    }
}

/// Render the PTC SDK as a conversation-start reminder instead of embedding
/// the large declaration block in the single `RunCode` tool description.
pub fn render_ptc_tool_calling_guide(sdk_source: &str) -> String {
    render_ptc_tool_calling_guide_with_options(sdk_source, true)
}

pub fn render_ptc_tool_calling_guide_for_language(
    sdk_source: &str,
    language: PtcLanguage,
    include_deferred_tool_apis: bool,
) -> String {
    if language.is_typescript() {
        return render_ptc_tool_calling_guide_with_options(sdk_source, include_deferred_tool_apis);
    }
    let deferred_guidance = if include_deferred_tool_apis {
        "\n\nFor deferred tools:\n1. Await `tools.get_tool_spec(\"tool_name\")` before choosing arguments.\n2. Read the returned `sdk_source`, which contains the input and output types.\n3. Await `tools.call_tool(\"tool_name\", args)` with arguments matching that SDK.\nDo not infer deferred tool arguments from the placeholder type."
    } else {
        ""
    };
    format!(
        "# Tool Calling Guide\nUse `RunCode` with a Python program only. The program is inserted into an already-running async function: use top-level `await` and never call `asyncio.run`. Use `await tools.ToolName(args)` for direct tools and return a JSON-serializable value. The runtime has already imported and bound `asyncio` and `json` in the execution scope; use them directly. Do not emit TypeScript/JavaScript (`const`, `let`, `Promise`, `=>`) or import other modules, including `os`, `pathlib`, `subprocess`, `requests`, and similar modules.{}\n\nGenerated SDK:\n```python\n{}\n```",
        deferred_guidance,
        sdk_source.trim(),
    )
}

/// Render the PTC conversation-start guide with wording that matches the
/// capabilities exposed by the generated SDK.
pub fn render_ptc_tool_calling_guide_with_options(
    sdk_source: &str,
    include_deferred_tool_apis: bool,
) -> String {
    let deferred_guidance = if include_deferred_tool_apis {
        "\n\nFor deferred tools:\n1. Call `tools.getToolSpec(\"tool_name\")` before choosing arguments.\n2. Read the returned `sdk_source`, which contains the input and output types.\n3. Call `tools.callTool(\"tool_name\", args)` with arguments matching that SDK.\nDo not infer deferred tool arguments from the placeholder `Record<string, unknown>` type."
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

fn is_python_identifier(value: &str) -> bool {
    if !is_typescript_identifier(value) {
        return false;
    }
    !matches!(
        value,
        "and"
            | "as"
            | "assert"
            | "async"
            | "await"
            | "break"
            | "case"
            | "class"
            | "continue"
            | "def"
            | "del"
            | "elif"
            | "else"
            | "except"
            | "False"
            | "finally"
            | "for"
            | "from"
            | "global"
            | "if"
            | "import"
            | "in"
            | "is"
            | "lambda"
            | "None"
            | "nonlocal"
            | "not"
            | "or"
            | "pass"
            | "raise"
            | "return"
            | "True"
            | "try"
            | "while"
            | "with"
            | "yield"
    )
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
        json_schema_to_typescript, ptc_run_code_description, ptc_run_code_description_for_language,
        ptc_run_code_input_schema, ptc_run_code_input_schema_for_language,
        render_ptc_loaded_tool_sdk, render_ptc_loaded_tool_typescript_sdk, render_ptc_sdk,
        render_ptc_tool_calling_guide, render_ptc_tool_calling_guide_for_language,
        render_ptc_tool_calling_guide_with_options, render_ptc_typescript_sdk,
        render_ptc_typescript_sdk_with_options, PtcToolContract,
    };
    use openbitfun_core_types::PtcLanguage;
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
        assert!(output.contains("Promise<{ language: string; sdk_source: string }>"));
        assert!(!output.contains("typescript_sdk"));
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
        assert!(guide.contains("Read the returned `sdk_source`"));
        assert!(!guide.contains("typescript_sdk"));
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
    fn python_sdk_exposes_valid_bindings_and_generic_deferred_apis() {
        let direct = PtcToolContract::new(
            "Read",
            "Read a file.",
            json!({"type": "object", "properties": {"path": {"type": "string"}, "limit": {"type": "integer"}}, "required": ["path"]}),
            json!({"type": "string"}),
        );
        let mut deferred = PtcToolContract::new(
            "tool.with-dash",
            "Deferred tool.",
            json!({"type": "object"}),
            json!({}),
        );
        deferred.is_deferred = true;
        let output = render_ptc_sdk(&[direct, deferred], PtcLanguage::Python);
        assert!(output.contains("ReadArgs = TypedDict("));
        assert!(output.contains("\"path\": Required[str]"));
        assert!(output.contains("\"limit\": NotRequired[int]"));
        assert!(output.contains("ReadOutput = str"));
        assert!(output.contains("async def Read(self, args: ReadArgs) -> ReadOutput"));
        assert!(output.contains("PtcToolSpec = TypedDict("));
        assert!(output.contains("\"language\": Required[str]"));
        assert!(output.contains("\"sdk_source\": Required[str]"));
        assert!(output.contains("async def get_tool_spec(self, name: str) -> PtcToolSpec"));
        assert!(output.contains("async def call_tool(self, name: str, args: dict[str, Any])"));
        assert!(!output.contains("async def tool.with-dash"));

        let loaded = render_ptc_loaded_tool_sdk(
            &PtcToolContract::new(
                "tool.with-dash",
                "Loaded tool.",
                json!({"type": "object"}),
                json!({"type": "string"}),
            ),
            PtcLanguage::Python,
        );
        assert!(loaded.contains("async def call_tool(self, name: str"));
        assert!(!loaded.contains("async def get_tool_spec(self"));
    }

    #[test]
    fn python_sdk_preserves_nested_object_shapes() {
        let contract = PtcToolContract::new(
            "ListFiles",
            "List files.",
            json!({
                "type": "object",
                "properties": {
                    "filter": {
                        "type": "object",
                        "properties": {
                            "pattern": {"type": "string"}
                        },
                        "required": ["pattern"],
                        "additionalProperties": false
                    }
                },
                "required": ["filter"],
                "additionalProperties": false
            }),
            json!({
                "type": "object",
                "properties": {
                    "entries": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "name": {"type": "string"},
                                "is_dir": {"type": "boolean"}
                            },
                            "required": ["name", "is_dir"],
                            "additionalProperties": false
                        }
                    }
                },
                "required": ["entries"],
                "additionalProperties": false
            }),
        );

        let output = render_ptc_sdk(&[contract], PtcLanguage::Python);
        assert!(output.contains("\"pattern\": Required[str]"));
        assert!(output.contains("\"filter\": Required[ListFilesArgsFilter]"));
        assert!(output.contains("\"name\": Required[str]"));
        assert!(output.contains("\"is_dir\": Required[bool]"));
        assert!(output.contains("\"entries\": Required[list[ListFilesOutputEntriesItem]]"));
    }

    #[test]
    fn python_calling_guide_uses_python_deferred_contract_name() {
        let guide = render_ptc_tool_calling_guide_for_language(
            "tools: PtcToolBindings",
            PtcLanguage::Python,
            true,
        );
        assert!(guide.contains("Python program"));
        assert!(guide.contains("Do not emit TypeScript/JavaScript"));
        assert!(guide.contains("already imported and bound `asyncio` and `json`"));
        assert!(guide
            .contains("including `os`, `pathlib`, `subprocess`, `requests`, and similar modules"));
        assert!(guide.contains("never call `asyncio.run`"));
        assert!(guide.contains("tools.get_tool_spec"));
        assert!(guide.contains("`sdk_source`"));
        assert!(!guide.contains("typescript_sdk"));
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

    #[test]
    fn python_run_code_contract_rejects_typescript_syntax() {
        let description = ptc_run_code_description_for_language(PtcLanguage::Python);
        assert!(description.contains("Do not emit TypeScript/JavaScript"));
        assert!(description.contains("`const`, `let`, `Promise`, or `=>`"));

        let schema = ptc_run_code_input_schema_for_language(PtcLanguage::Python);
        let code_description = schema["properties"]["code"]["description"]
            .as_str()
            .expect("Python RunCode code description should be a string");
        assert_eq!(
            code_description,
            "Python source code executed inside an existing async function. Use top-level `await`; do not call `asyncio.run`."
        );
    }
}
