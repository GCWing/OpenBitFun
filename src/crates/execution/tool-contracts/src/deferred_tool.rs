use serde::Serialize;
use serde_json::{Map, Value};
use std::fmt;

pub const CALL_DEFERRED_TOOL_NAME: &str = "CallDeferredTool";

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CallDeferredToolInput {
    pub tool_name: String,
    pub args: Value,
}

impl CallDeferredToolInput {
    pub fn canonical_wire_arguments(&self) -> Value {
        serde_json::json!({
            "tool_name": self.tool_name,
            "args": self.args,
        })
    }

    /// Serialize through the typed envelope so `tool_name` precedes `args` in
    /// provider-visible replay JSON even when JSON object maps reorder keys.
    pub fn canonical_wire_json(&self) -> serde_json::Result<String> {
        serde_json::to_string(self)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CallDeferredToolInputError {
    InputMustBeObject,
    MissingToolName,
    EmptyToolName,
    MissingArgs,
    ArgsMustBeObject,
    UnexpectedField(String),
}

impl fmt::Display for CallDeferredToolInputError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InputMustBeObject => {
                write!(formatter, "CallDeferredTool input must be an object")
            }
            Self::MissingToolName => write!(formatter, "tool_name is required"),
            Self::EmptyToolName => write!(formatter, "tool_name cannot be empty"),
            Self::MissingArgs => write!(formatter, "args is required"),
            Self::ArgsMustBeObject => write!(formatter, "args must be an object"),
            Self::UnexpectedField(field) => {
                write!(formatter, "unexpected CallDeferredTool field: {field}")
            }
        }
    }
}

impl std::error::Error for CallDeferredToolInputError {}

pub fn call_deferred_tool_input_schema() -> Value {
    serde_json::json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["tool_name", "args"],
        "properties": {
            "tool_name": {
                "type": "string",
                "description": "Exact deferred tool name whose full GetToolSpec result is still visible in the current context."
            },
            "args": {
                "type": "object",
                "additionalProperties": true,
                "description": "Arguments matching the schema returned by GetToolSpec."
            }
        }
    })
}

pub fn call_deferred_tool_short_description() -> String {
    "Call a deferred tool whose full schema was loaded with GetToolSpec.".to_string()
}

pub fn call_deferred_tool_description() -> String {
    r#"Call a deferred tool after reading its full schema with GetToolSpec.

The full GetToolSpec result must still be visible in the current context. If compaction or truncation removed it, reload it with GetToolSpec first; a summary or a past call is not a loaded definition.
Pass the exact deferred tool name in tool_name and put only that tool's arguments inside args.
The order is important. ALWAYS output tool_name first, then args."#
        .to_string()
}

pub fn parse_call_deferred_tool_input(
    input: &Value,
) -> Result<CallDeferredToolInput, CallDeferredToolInputError> {
    let object = input
        .as_object()
        .ok_or(CallDeferredToolInputError::InputMustBeObject)?;

    let tool_name = object
        .get("tool_name")
        .and_then(Value::as_str)
        .ok_or(CallDeferredToolInputError::MissingToolName)?;
    if tool_name.trim().is_empty() {
        return Err(CallDeferredToolInputError::EmptyToolName);
    }

    let mut args = match object.get("args") {
        Some(Value::Object(args)) => args.clone(),
        Some(_) => return Err(CallDeferredToolInputError::ArgsMustBeObject),
        None => Map::new(),
    };

    for (field, value) in object {
        if field != "tool_name" && field != "args" && !args.contains_key(field) {
            args.insert(field.clone(), value.clone());
        }
    }

    Ok(CallDeferredToolInput {
        tool_name: tool_name.to_string(),
        args: Value::Object(args),
    })
}

fn parse_call_deferred_tool_input_ref(
    input: &Value,
) -> Result<(&str, &Value), CallDeferredToolInputError> {
    let object = input
        .as_object()
        .ok_or(CallDeferredToolInputError::InputMustBeObject)?;

    if let Some(field) = object
        .keys()
        .find(|field| field.as_str() != "tool_name" && field.as_str() != "args")
    {
        return Err(CallDeferredToolInputError::UnexpectedField(field.clone()));
    }

    let tool_name = object
        .get("tool_name")
        .and_then(Value::as_str)
        .ok_or(CallDeferredToolInputError::MissingToolName)?;
    if tool_name.trim().is_empty() {
        return Err(CallDeferredToolInputError::EmptyToolName);
    }

    let args = object
        .get("args")
        .ok_or(CallDeferredToolInputError::MissingArgs)?;
    if !args.is_object() {
        return Err(CallDeferredToolInputError::ArgsMustBeObject);
    }

    Ok((tool_name, args))
}

/// Project a provider-facing invocation to the runtime tool identity without
/// allocating or duplicating persisted arguments. Invalid gateway payloads
/// fall back to their wire identity so historical data remains renderable.
pub fn effective_tool_invocation<'a>(
    wire_tool_name: &'a str,
    wire_arguments: &'a Value,
) -> (&'a str, &'a Value) {
    if wire_tool_name != CALL_DEFERRED_TOOL_NAME {
        return (wire_tool_name, wire_arguments);
    }

    parse_call_deferred_tool_input_ref(wire_arguments).unwrap_or((wire_tool_name, wire_arguments))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolInvocationKind {
    Direct,
    Deferred { gateway_tool_name: String },
}

#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedToolInvocation {
    pub wire_tool_name: String,
    pub wire_arguments: Value,
    pub effective_tool_name: String,
    pub effective_arguments: Value,
    pub kind: ToolInvocationKind,
}

impl ResolvedToolInvocation {
    pub fn direct(tool_name: impl Into<String>, arguments: Value) -> Self {
        let tool_name = tool_name.into();
        Self {
            wire_tool_name: tool_name.clone(),
            wire_arguments: arguments.clone(),
            effective_tool_name: tool_name,
            effective_arguments: arguments,
            kind: ToolInvocationKind::Direct,
        }
    }

    pub fn from_wire_call(
        tool_name: impl Into<String>,
        arguments: Value,
    ) -> Result<Self, CallDeferredToolInputError> {
        let tool_name = tool_name.into();
        if tool_name != CALL_DEFERRED_TOOL_NAME {
            return Ok(Self::direct(tool_name, arguments));
        }

        let parsed = parse_call_deferred_tool_input(&arguments)?;
        let wire_arguments = parsed.canonical_wire_arguments();
        Ok(Self {
            wire_tool_name: tool_name.clone(),
            wire_arguments,
            effective_tool_name: parsed.tool_name,
            effective_arguments: parsed.args,
            kind: ToolInvocationKind::Deferred {
                gateway_tool_name: tool_name,
            },
        })
    }

    pub fn is_deferred(&self) -> bool {
        matches!(self.kind, ToolInvocationKind::Deferred { .. })
    }

    pub fn replace_effective_arguments(&mut self, arguments: Value) {
        self.effective_arguments = arguments.clone();
        match self.kind {
            ToolInvocationKind::Direct => self.wire_arguments = arguments,
            ToolInvocationKind::Deferred { .. } => {
                if let Some(object) = self.wire_arguments.as_object_mut() {
                    object.insert("args".to_string(), arguments);
                }
            }
        }
    }
}
