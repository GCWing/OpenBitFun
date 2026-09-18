//! OpenBitFunControl — discover and control user-facing OpenBitFun features and settings.

use crate::agentic::agents::get_agent_registry;
use crate::agentic::tools::framework::{
    PermissionIntent, Tool, ToolResult, ToolUseContext, ValidationResult,
};
use crate::agentic::tools::openbitfun_control_config::{
    global_shared_product_control_executor, SharedProductControlExecutor,
};
use crate::agentic::tools::openbitfun_control_host::{
    invoke_openbitfun_control, openbitfun_control_host_available, OpenBitFunControlHostRequest,
    ProductControlAction,
};
#[cfg(test)]
use crate::service::config::ConfigService;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use async_trait::async_trait;
use openbitfun_product_domains::product_control::{
    capability as product_capability, discover as discover_product_capabilities,
    validate_open_target, validate_operation_argument_scopes, validate_operation_arguments,
    validate_option_value, ProductControlDeliveryProfile, ProductControlRisk, ProductControlSource,
};
use serde_json::{json, Value};
use std::sync::Arc;

const ACTIONS: &[&str] = &["list", "search", "get", "open", "execute", "configure"];
const INPUT_ID_ALIASES: &[(&str, &str)] = &[
    ("capability_id", "capabilityId"),
    ("item_id", "itemId"),
    ("operation_id", "operationId"),
    ("option_id", "optionId"),
];

pub struct OpenBitFunControlTool {
    shared_executor: Option<Arc<SharedProductControlExecutor>>,
}

impl OpenBitFunControlTool {
    pub fn new() -> Self {
        Self {
            shared_executor: None,
        }
    }

    #[cfg(test)]
    fn with_config_service(config_service: Arc<ConfigService>) -> Self {
        Self {
            shared_executor: Some(Arc::new(SharedProductControlExecutor::new(config_service))),
        }
    }

    async fn shared_executor(&self) -> Result<Arc<SharedProductControlExecutor>, String> {
        if let Some(executor) = &self.shared_executor {
            return Ok(executor.clone());
        }
        global_shared_product_control_executor().await
    }

    fn assistant_payload(result: &Value) -> String {
        // Keep on-demand control responses structured without paying the
        // context cost of pretty-print whitespace on every discovery step.
        serde_json::to_string(result).unwrap_or_else(|_| result.to_string())
    }

    async fn inspect_shared_capability(&self, capability_id: &str) -> OpenBitFunResult<Value> {
        match self.shared_executor().await {
            Ok(executor) => executor
                .inspect(capability_id, ProductControlDeliveryProfile::Cli)
                .await
                .map_err(OpenBitFunError::tool),
            Err(error) => {
                let mut result =
                    openbitfun_product_domains::product_control::inspect_contract(capability_id)
                        .map_err(OpenBitFunError::tool)?;
                let object = result.as_object_mut().ok_or_else(|| {
                    OpenBitFunError::tool(
                        "Product-control inspection was not an object".to_string(),
                    )
                })?;
                object.insert(
                    "controlAvailability".to_string(),
                    json!({
                        "status": "unavailable",
                        "contractAvailable": true,
                        "readBack": false,
                        "reason": format!("Shared OpenBitFun configuration is unavailable: {error}"),
                    }),
                );
                Ok(result)
            }
        }
    }

    async fn configure_shared_option(
        &self,
        request: &OpenBitFunControlHostRequest,
    ) -> OpenBitFunResult<Value> {
        self.shared_executor()
            .await
            .map_err(OpenBitFunError::tool)?
            .configure(request)
            .await
            .map_err(OpenBitFunError::tool)
    }

    fn action(input: &Value) -> Option<&str> {
        input.get("action").and_then(Value::as_str).map(str::trim)
    }

    fn aliased_field<'a>(input: &'a Value, canonical: &str, alias: &str) -> Option<&'a Value> {
        input.get(canonical).or_else(|| input.get(alias))
    }

    fn aliased_string<'a>(input: &'a Value, canonical: &str, alias: &str) -> Option<&'a str> {
        Self::aliased_field(input, canonical, alias)
            .and_then(Value::as_str)
            .map(str::trim)
    }

    fn validate_input_aliases(input: &Value) -> Result<(), String> {
        for (canonical, alias) in INPUT_ID_ALIASES {
            if let (Some(canonical_value), Some(alias_value)) =
                (input.get(*canonical), input.get(*alias))
            {
                if canonical_value != alias_value {
                    return Err(format!(
                        "{canonical} and its compatibility alias {alias} must not disagree"
                    ));
                }
            }
        }
        Ok(())
    }

    fn capability_id(input: &Value) -> Option<&str> {
        Self::aliased_string(input, "capability_id", "capabilityId")
    }

    fn item_id(input: &Value) -> Option<&str> {
        Self::aliased_string(input, "item_id", "itemId")
    }

    fn operation_id(input: &Value) -> Option<&str> {
        Self::aliased_string(input, "operation_id", "operationId")
    }

    fn option_id(input: &Value) -> Option<&str> {
        Self::aliased_string(input, "option_id", "optionId")
    }

    fn requires_capability_id(action: &str) -> bool {
        matches!(action, "get" | "open" | "execute" | "configure")
    }

    fn typed_action(action: &str) -> Option<ProductControlAction> {
        match action {
            "list" => Some(ProductControlAction::List),
            "search" => Some(ProductControlAction::Search),
            "get" => Some(ProductControlAction::Get),
            "open" => Some(ProductControlAction::Open),
            "execute" => Some(ProductControlAction::Execute),
            "configure" => Some(ProductControlAction::Configure),
            _ => None,
        }
    }

    fn configure_value(input: &Value) -> Result<Option<Value>, String> {
        let mut values = Vec::new();
        let typed_fields = [
            ("value_boolean", "boolean"),
            ("value_string", "string"),
            ("value_integer", "integer"),
            ("value_number", "number"),
            ("value_object", "object"),
            ("value_array", "array"),
        ];
        for (field, expected_type) in typed_fields {
            let Some(value) = input.get(field) else {
                continue;
            };
            let valid = match expected_type {
                "boolean" => value.is_boolean(),
                "string" => value.is_string(),
                "integer" => value.as_i64().is_some() || value.as_u64().is_some(),
                "number" => value.is_number(),
                "object" => value.is_object(),
                "array" => value.is_array(),
                _ => false,
            };
            if !valid {
                return Err(format!("{field} must be a JSON {expected_type}"));
            }
            values.push((field, value.clone()));
        }
        if let Some(value) = input.get("value_null") {
            if value != &Value::Bool(true) {
                return Err("value_null must be true when used".to_string());
            }
            values.push(("value_null", Value::Null));
        }
        // Preserve compatibility with calls produced before typed value fields
        // were added. It is intentionally absent from the prompt schema so new
        // model calls cannot have an untyped value coerced by a provider.
        if let Some(value) = input.get("value") {
            values.push(("value", value.clone()));
        }
        if values.len() > 1 {
            return Err(format!(
                "configure accepts exactly one typed value field; received {}",
                values
                    .iter()
                    .map(|(field, _)| *field)
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        Ok(values.into_iter().next().map(|(_, value)| value))
    }

    fn agent_is_readonly(context: &ToolUseContext) -> bool {
        let Some(agent_type) = context.agent_type.as_deref() else {
            return false;
        };
        get_agent_registry()
            .get_agent(agent_type, context.workspace_id())
            .is_some_and(|agent| agent.is_readonly())
    }

    fn operation_is_readonly(input: &Value) -> bool {
        let (Some(capability_id), Some(operation_id)) =
            (Self::capability_id(input), Self::operation_id(input))
        else {
            return false;
        };
        product_capability(capability_id)
            .ok()
            .and_then(|capability| {
                capability
                    .operations
                    .iter()
                    .find(|operation| operation.id == operation_id)
            })
            .is_some_and(|operation| operation.risk == ProductControlRisk::Read)
    }

    fn headless_unsupported(request: &OpenBitFunControlHostRequest) -> String {
        let definition_id = match request.action {
            ProductControlAction::Execute => request.operation_id.as_ref().map(|operation_id| {
                format!(
                    "{}:operation:{operation_id}",
                    request.capability_id.as_deref().unwrap_or_default()
                )
            }),
            ProductControlAction::Open => request.item_id.as_ref().map(|item_id| {
                format!(
                    "{}:open:{item_id}",
                    request.capability_id.as_deref().unwrap_or_default()
                )
            }),
            _ => None,
        };
        let reason = definition_id
            .as_deref()
            .and_then(|definition_id| {
                openbitfun_product_domains::product_control::ProductControlRegistry::global()
                    .definition(definition_id)
                    .ok()
            })
            .and_then(|definition| {
                definition
                    .availability
                    .get(&ProductControlDeliveryProfile::Cli)
            })
            .and_then(|availability| availability.reason.as_deref())
            .unwrap_or("This action requires a product-host or presentation adapter");
        format!(
            "unsupported[profile=headless]: {} {} is unavailable on this OpenBitFun surface: {reason}",
            request.action.as_str(),
            definition_id.as_deref().unwrap_or("product-control action")
        )
    }

    fn validate_operation_scope(input: &Value, context: &ToolUseContext) -> Result<(), String> {
        if Self::action(input) != Some("execute") {
            return Ok(());
        }
        let capability_id = Self::capability_id(input).unwrap_or_default();
        let operation_id = Self::operation_id(input).unwrap_or_default();
        let capability = product_capability(capability_id)?;
        let operation = capability
            .operations
            .iter()
            .find(|operation| operation.id == operation_id)
            .ok_or_else(|| format!("Operation {operation_id} is not exposed by {capability_id}"))?;
        validate_operation_argument_scopes(operation, input.get("arguments"), context.is_remote())
    }
}

impl Default for OpenBitFunControlTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Tool for OpenBitFunControlTool {
    fn name(&self) -> &str {
        "OpenBitFunControl"
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok(
            "Control OpenBitFun itself through its internal ProductControl API. Use the two-step flow: first `list` or `search`, then `get` the matching capability and follow its returned schema and availability to `configure`, `execute`, or `open`. To show a capability's root surface, call `open` with only its capability_id. destination.actionId is presentation metadata, never an item_id or operation_id. The full catalog loads only on demand; never guess IDs or values."
                .to_string(),
        )
    }

    fn short_description(&self) -> String {
        "Discover and control OpenBitFun features and settings.".to_string()
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["action"],
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ACTIONS,
                    "description": "Discovery: list/search/get. Control: open/execute/configure. Discover a capability before controlling it."
                },
                "query": {
                    "type": "string",
                    "description": "Chinese or English query for search."
                },
                "capability_id": {
                    "type": "string",
                    "description": "Canonical tool field: copy the returned capabilityId or nextToolCall.capability_id value here."
                },
                "item_id": {
                    "type": "string",
                    "description": "Optional canonical tool field: copy a returned items[].id/itemId here to open an exact subview. Omit it to open the capability root; never copy destination.actionId here."
                },
                "operation_id": {
                    "type": "string",
                    "description": "User-level operations[].id returned by get; required for execute. A destination.actionId is not an operation ID."
                },
                "arguments": {
                    "type": "object",
                    "description": "Arguments for execute, following the operation input schema returned by get. Omit for operations with no arguments."
                },
                "option_id": {
                    "type": "string",
                    "description": "Canonical tool field: copy a user-level options[].id returned by get; required for configure."
                },
                "value_boolean": {
                    "type": "boolean",
                    "description": "Configure value when get returns valueSchema.type=boolean."
                },
                "value_string": {
                    "type": "string",
                    "description": "Configure value when get returns valueSchema.type=string."
                },
                "value_integer": {
                    "type": "integer",
                    "description": "Configure value when get returns valueSchema.type=integer."
                },
                "value_number": {
                    "type": "number",
                    "description": "Configure value when get returns valueSchema.type=number."
                },
                "value_object": {
                    "type": "object",
                    "description": "Configure value when get returns valueSchema.type=object."
                },
                "value_array": {
                    "type": "array",
                    "description": "Configure value when get returns valueSchema.type=array."
                },
                "value_null": {
                    "type": "boolean",
                    "enum": [true],
                    "description": "Set a nullable option to null; pass true."
                },
                "cursor": {
                    "type": "integer",
                    "minimum": 0,
                    "description": "Zero-based list/search cursor."
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 50,
                    "description": "Maximum results per page. Defaults to 50 for list and 20 for search; use nextCursor to continue."
                }
            }
        })
    }

    async fn is_available_in_context(&self, _context: Option<&ToolUseContext>) -> bool {
        openbitfun_product_domains::product_control::catalog().is_ok()
    }

    fn is_readonly(&self) -> bool {
        false
    }

    fn is_concurrency_safe(&self, input: Option<&Value>) -> bool {
        input
            .and_then(Self::action)
            .is_some_and(|action| matches!(action, "list" | "search" | "get"))
    }

    fn permission_intents(
        &self,
        input: &Value,
        _context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<PermissionIntent>> {
        let action = Self::action(input).unwrap_or("<missing-action>");
        if matches!(action, "list" | "search" | "get") {
            return Ok(Vec::new());
        }
        if action == "execute" && Self::operation_is_readonly(input) {
            return Ok(Vec::new());
        }
        let capability_id = Self::capability_id(input)
            .filter(|value| !value.is_empty())
            .unwrap_or("<missing-capability-id>");
        let target = match action {
            "execute" => Self::operation_id(input)
                .filter(|value| !value.is_empty())
                .map(|value| format!("{capability_id}:{value}"))
                .unwrap_or_else(|| capability_id.to_string()),
            "configure" => Self::option_id(input)
                .filter(|value| !value.is_empty())
                .map(|value| format!("{capability_id}:{value}"))
                .unwrap_or_else(|| capability_id.to_string()),
            "open" => Self::item_id(input)
                .filter(|value| !value.is_empty())
                .map(|value| format!("{capability_id}:{value}"))
                .unwrap_or_else(|| capability_id.to_string()),
            _ => capability_id.to_string(),
        };
        Ok(vec![PermissionIntent::new(
            "openbitfun_control",
            vec![format!("{action}:{target}")],
        )])
    }

    async fn validate_input(
        &self,
        input: &Value,
        context: Option<&ToolUseContext>,
    ) -> ValidationResult {
        let invalid = |message: &str| ValidationResult {
            result: false,
            message: Some(message.to_string()),
            error_code: None,
            meta: None,
        };
        if !input.is_object() {
            return invalid("Input must be an object.");
        }
        if let Err(error) = Self::validate_input_aliases(input) {
            return invalid(&error);
        }
        let Some(action) = Self::action(input) else {
            return invalid("action is required.");
        };
        if !ACTIONS.contains(&action) {
            return invalid(
                "action must be one of list, search, get, open, execute, or configure.",
            );
        }
        if action == "search"
            && !input
                .get("query")
                .and_then(Value::as_str)
                .is_some_and(|query| !query.trim().is_empty())
        {
            return invalid("query is required for search.");
        }
        if Self::requires_capability_id(action)
            && !Self::capability_id(input).is_some_and(|id| !id.is_empty())
        {
            return invalid(
                "capability_id is required for get, open, execute, and configure (capabilityId is accepted as a compatibility alias).",
            );
        }
        if Self::aliased_field(input, "item_id", "itemId").is_some_and(|value| {
            !value
                .as_str()
                .is_some_and(|item_id| !item_id.trim().is_empty())
        }) {
            return invalid("item_id must be a non-empty string when provided.");
        }
        if action == "execute" && !Self::operation_id(input).is_some_and(|id| !id.is_empty()) {
            return invalid("operation_id is required for execute.");
        }
        if input
            .get("arguments")
            .is_some_and(|arguments| !arguments.is_object())
        {
            return invalid("arguments must be an object when provided.");
        }
        if action == "configure" && !Self::option_id(input).is_some_and(|id| !id.is_empty()) {
            return invalid("option_id is required for configure.");
        }
        let configure_value = if action == "configure" {
            match Self::configure_value(input) {
                Ok(Some(value)) => Some(value),
                Ok(None) => {
                    return invalid("Exactly one typed value field is required for configure.")
                }
                Err(error) => return invalid(&error),
            }
        } else {
            None
        };
        if action != "configure" {
            match Self::configure_value(input) {
                Ok(None) => {}
                Ok(Some(_)) => return invalid("Typed value fields are only valid for configure."),
                Err(error) => return invalid(&error),
            }
        }
        if matches!(action, "get" | "open") {
            let capability_id = Self::capability_id(input).unwrap_or_default();
            if action == "open" {
                if let Err(error) = validate_open_target(capability_id, Self::item_id(input)) {
                    let valid_items = product_capability(capability_id)
                        .map(|capability| {
                            capability
                                .items
                                .iter()
                                .map(|item| item.id.as_str())
                                .collect::<Vec<_>>()
                                .join(", ")
                        })
                        .unwrap_or_default();
                    return invalid(&format!(
                        "{error}. Valid item_id values: [{valid_items}]. To open the capability root, call {{\"action\":\"open\",\"capability_id\":\"{capability_id}\"}} and omit item_id. destination.actionId is presentation metadata, not an item_id or operation_id."
                    ));
                }
            } else if product_capability(capability_id).is_err() {
                return invalid("capability_id does not identify a known OpenBitFun capability.");
            }
        }
        if action == "execute" {
            let capability_id = Self::capability_id(input).unwrap_or_default();
            let operation_id = Self::operation_id(input).unwrap_or_default();
            let Ok(capability) = product_capability(capability_id) else {
                return invalid("capability_id does not identify a known OpenBitFun capability.");
            };
            let Some(operation) = capability
                .operations
                .iter()
                .find(|operation| operation.id == operation_id)
            else {
                let valid_operations = capability
                    .operations
                    .iter()
                    .map(|operation| operation.id.as_str())
                    .collect::<Vec<_>>()
                    .join(", ");
                let delegated_tool = capability
                    .agent_control
                    .as_ref()
                    .map(|control| control.tool.as_str())
                    .unwrap_or("none");
                return invalid(&format!(
                    "operation_id is not exposed by this OpenBitFun capability. Valid operation_id values: [{valid_operations}]. The delegated Agent tool is {delegated_tool}. destination.actionId is presentation metadata and cannot be executed as an operation."
                ));
            };
            if let Err(error) =
                validate_operation_arguments(&operation.input_schema, input.get("arguments"))
            {
                return invalid(&error);
            }
        }
        if action == "configure" {
            let capability_id = Self::capability_id(input).unwrap_or_default();
            let option_id = Self::option_id(input).unwrap_or_default();
            let Ok(capability) = product_capability(capability_id) else {
                return invalid("capability_id does not identify a known OpenBitFun capability.");
            };
            let Some(option) = capability
                .options
                .iter()
                .find(|option| option.id == option_id)
            else {
                return invalid("option_id is not exposed by this OpenBitFun setting.");
            };
            if let Some(value) = configure_value.as_ref() {
                if let Err(error) = validate_option_value(&option.value_schema, value) {
                    return invalid(&error);
                }
            }
        }
        if input
            .get("cursor")
            .is_some_and(|value| value.as_u64().is_none())
        {
            return invalid("cursor must be a non-negative integer when provided.");
        }
        if input.get("limit").is_some_and(|value| {
            value
                .as_u64()
                .is_none_or(|limit| !(1..=50).contains(&limit))
        }) {
            return invalid("limit must be an integer between 1 and 50.");
        }
        if let Some(context) = context {
            if let Err(error) = Self::validate_operation_scope(input, context) {
                return invalid(&error);
            }
        }
        ValidationResult::default()
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        Self::validate_input_aliases(input).map_err(OpenBitFunError::tool)?;
        let action = Self::action(input)
            .ok_or_else(|| OpenBitFunError::tool("action is required".to_string()))?;
        let typed_action = Self::typed_action(action).ok_or_else(|| {
            OpenBitFunError::tool(format!("Unsupported OpenBitFunControl action: {action}"))
        })?;
        Self::validate_operation_scope(input, context).map_err(OpenBitFunError::tool)?;
        let mutating_control = matches!(action, "open" | "configure")
            || (action == "execute" && !Self::operation_is_readonly(input));
        if mutating_control && Self::agent_is_readonly(context) {
            return Err(OpenBitFunError::tool(
                "This read-only agent may discover OpenBitFun features and settings but cannot control them"
                    .to_string(),
            ));
        }

        let request = OpenBitFunControlHostRequest {
            action: typed_action,
            query: input
                .get("query")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string),
            capability_id: Self::capability_id(input)
                .filter(|value| !value.is_empty())
                .map(str::to_string),
            item_id: Self::item_id(input)
                .filter(|value| !value.is_empty())
                .map(str::to_string),
            operation_id: Self::operation_id(input)
                .filter(|value| !value.is_empty())
                .map(str::to_string),
            option_id: Self::option_id(input)
                .filter(|value| !value.is_empty())
                .map(str::to_string),
            arguments: input.get("arguments").cloned(),
            value: if typed_action == ProductControlAction::Configure {
                Self::configure_value(input).map_err(OpenBitFunError::tool)?
            } else {
                None
            },
            cursor: input
                .get("cursor")
                .and_then(Value::as_u64)
                .and_then(|value| usize::try_from(value).ok()),
            limit: input
                .get("limit")
                .and_then(Value::as_u64)
                .and_then(|value| usize::try_from(value).ok()),
            source: ProductControlSource::Agent,
        };

        let result = match typed_action {
            ProductControlAction::List | ProductControlAction::Search => {
                discover_product_capabilities(&request).map_err(OpenBitFunError::tool)?
            }
            ProductControlAction::Get => {
                let capability_id = request.capability_id.as_deref().ok_or_else(|| {
                    OpenBitFunError::tool("capability_id is required".to_string())
                })?;
                let mut result = if openbitfun_control_host_available() {
                    match invoke_openbitfun_control(request.clone()).await {
                        Ok(result) => result,
                        Err(error) => {
                            let mut result = self.inspect_shared_capability(capability_id).await?;
                            if let Some(object) = result.as_object_mut() {
                                object.insert(
                                    "hostAdapterAvailability".to_string(),
                                    json!({
                                        "status": "degraded",
                                        "reason": error,
                                    }),
                                );
                            }
                            result
                        }
                    }
                } else {
                    self.inspect_shared_capability(capability_id).await?
                };
                if let Some(object) = result.as_object_mut() {
                    let capability =
                        product_capability(capability_id).map_err(OpenBitFunError::tool)?;
                    object.insert(
                        "toolInput".to_string(),
                        json!({ "capability_id": capability_id }),
                    );
                    object.insert(
                        "nextToolCalls".to_string(),
                        json!({
                            "openCapabilityRoot": {
                                "action": "open",
                                "capability_id": capability_id,
                            },
                            "delegateTool": capability
                                .agent_control
                                .as_ref()
                                .map(|control| control.tool.as_str()),
                            "validItemIds": capability
                                .items
                                .iter()
                                .map(|item| item.id.as_str())
                                .collect::<Vec<_>>(),
                            "validOperationIds": capability
                                .operations
                                .iter()
                                .map(|operation| operation.id.as_str())
                                .collect::<Vec<_>>(),
                            "validOptionIds": capability
                                .options
                                .iter()
                                .map(|option| option.id.as_str())
                                .collect::<Vec<_>>(),
                        }),
                    );
                    object.insert(
                        "idNamespaceRules".to_string(),
                        json!({
                            "destinationActionIdCallable": false,
                            "note": "capability.destination and item.destination are presentation metadata. Use only returned item, operation, and option IDs in their matching OpenBitFunControl fields.",
                        }),
                    );
                }
                result
            }
            ProductControlAction::Configure => {
                if openbitfun_control_host_available() {
                    invoke_openbitfun_control(request)
                        .await
                        .map_err(OpenBitFunError::tool)?
                } else {
                    self.configure_shared_option(&request).await?
                }
            }
            ProductControlAction::Open | ProductControlAction::Execute => {
                if !openbitfun_control_host_available() {
                    return Err(OpenBitFunError::tool(Self::headless_unsupported(&request)));
                }
                invoke_openbitfun_control(request)
                    .await
                    .map_err(OpenBitFunError::tool)?
            }
        };

        // The model needs the IDs, schemas, availability, and effective values
        // to perform the second step. A prose success summary would hide the
        // structured payload because result_for_assistant is authoritative.
        let assistant = Self::assistant_payload(&result);
        Ok(vec![ToolResult::ok(result, Some(assistant))])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::PathManager;
    use crate::service::config::ConfigManagerSettings;
    use std::collections::HashMap;

    fn context() -> ToolUseContext {
        ToolUseContext {
            tool_call_id: None,
            agent_type: None,
            session_id: None,
            dialog_turn_id: None,
            workspace: None,
            loaded_deferred_tool_specs: Vec::new(),
            primary_model_facts: tool_runtime::context::PrimaryModelFacts::default(),
            custom_data: HashMap::new(),
            computer_use_host: None,
            runtime_tool_restrictions: Default::default(),
            runtime_handles: openbitfun_runtime_ports::ToolRuntimeHandles::default(),
        }
    }

    fn remote_context() -> ToolUseContext {
        let mut context = context();
        context.workspace = Some(crate::agentic::WorkspaceBinding::new_remote(
            None,
            std::path::PathBuf::from("/remote/workspace"),
            "connection-1".to_string(),
            "Remote".to_string(),
            crate::service::remote_ssh::workspace_state::WorkspaceSessionIdentity {
                workspace_kind: openbitfun_core_types::WorkspaceKind::Remote,
                hostname: "remote.example".to_string(),
                logical_workspace_path: "/remote/workspace".to_string(),
                remote_connection_id: Some("connection-1".to_string()),
            },
        ));
        context
    }

    async fn tool_with_temp_config(name: &str) -> (OpenBitFunControlTool, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path_manager = Arc::new(PathManager::with_user_root_for_tests(dir.path().join(name)));
        let config_service = Arc::new(
            ConfigService::with_settings(ConfigManagerSettings {
                path_manager: Some(path_manager),
                auto_save: true,
                backup_count: 0,
            })
            .await
            .expect("config service"),
        );
        (
            OpenBitFunControlTool::with_config_service(config_service),
            dir,
        )
    }

    #[tokio::test]
    async fn description_keeps_the_catalog_out_of_the_prompt() {
        let description = OpenBitFunControlTool::new().description().await.unwrap();
        assert!(description.contains("two-step"));
        assert!(description.contains("list"));
        assert!(description.contains("search"));
        assert!(description.contains("get"));
        assert!(!description.contains("get_configs"));
        assert!(description.len() < 600);

        let schema = OpenBitFunControlTool::new().input_schema();
        assert_eq!(schema["properties"]["value_boolean"]["type"], "boolean");
        assert_eq!(schema["properties"]["value_integer"]["type"], "integer");
        assert!(schema["properties"].get("value").is_none());
    }

    #[tokio::test]
    async fn validates_the_discover_then_execute_contract() {
        let tool = OpenBitFunControlTool::new();
        assert!(
            tool.validate_input(&json!({ "action": "list" }), None)
                .await
                .result
        );
        assert!(
            !tool
                .validate_input(&json!({ "action": "search" }), None)
                .await
                .result
        );
        assert!(
            !tool
                .validate_input(&json!({ "action": "execute" }), None)
                .await
                .result
        );
        assert!(
            tool.validate_input(
                &json!({
                    "action": "execute",
                    "capability_id": "feature.ai-assistant",
                    "operation_id": "new-session"
                }),
                None,
            )
            .await
            .result
        );
        assert!(
            tool.validate_input(
                &json!({
                    "action": "configure",
                    "capabilityId": "setting.tools.execution",
                    "optionId": "deferred-tool-loading",
                    "value_boolean": false
                }),
                None,
            )
            .await
            .result
        );
        assert!(
            !tool
                .validate_input(
                    &json!({
                        "action": "get",
                        "capability_id": "setting.tools.execution",
                        "capabilityId": "feature.ai-assistant"
                    }),
                    None,
                )
                .await
                .result
        );
        assert!(
            tool.validate_input(
                &json!({
                    "action": "configure",
                    "capability_id": "setting.application.general",
                    "option_id": "auto-update",
                    "value": false
                }),
                None,
            )
            .await
            .result
        );
        assert!(
            !tool
                .validate_input(
                    &json!({
                        "action": "execute",
                        "capability_id": "setting.application.pet",
                        "operation_id": "use-pet",
                        "arguments": {}
                    }),
                    None,
                )
                .await
                .result
        );
        assert!(
            !tool
                .validate_input(
                    &json!({
                        "action": "open",
                        "capability_id": "setting.application.input",
                        "item_id": "removed-setting-row"
                    }),
                    None,
                )
                .await
                .result
        );
        assert!(
            !tool
                .validate_input(
                    &json!({
                        "action": "configure",
                        "capability_id": "setting.application.pet",
                        "option_id": "display-mode",
                        "value": "floating"
                    }),
                    None,
                )
                .await
                .result
        );
    }

    #[tokio::test]
    async fn invalid_presentation_ids_return_an_exact_recovery_call() {
        let tool = OpenBitFunControlTool::new();
        let invalid_item = tool
            .validate_input(
                &json!({
                    "action": "open",
                    "capability_id": "feature.browser",
                    "item_id": "surface.browser.open",
                }),
                None,
            )
            .await;
        assert!(!invalid_item.result);
        let item_message = invalid_item.message.unwrap_or_default();
        assert!(item_message.contains("omit item_id"));
        assert!(item_message.contains("\"capability_id\":\"feature.browser\""));
        assert!(item_message.contains("presentation metadata"));

        let invalid_operation = tool
            .validate_input(
                &json!({
                    "action": "execute",
                    "capability_id": "feature.browser",
                    "operation_id": "surface.browser.open",
                }),
                None,
            )
            .await;
        assert!(!invalid_operation.result);
        let operation_message = invalid_operation.message.unwrap_or_default();
        assert!(operation_message.contains("Valid operation_id values: []"));
        assert!(operation_message.contains("ControlHub"));
        assert!(operation_message.contains("cannot be executed as an operation"));
    }

    #[tokio::test]
    async fn discovery_payload_exposes_ids_to_the_model() {
        let tool = OpenBitFunControlTool::new();
        let results = tool
            .call_impl(
                &json!({
                    "action": "search",
                    "query": "延迟加载工具 deferred tool loading",
                    "limit": 20
                }),
                &context(),
            )
            .await
            .unwrap();
        let ToolResult::Result {
            data,
            result_for_assistant,
            ..
        } = &results[0]
        else {
            panic!("expected a structured product-control result");
        };
        assert!(data["items"].as_array().is_some_and(|items| items
            .iter()
            .any(|item| item["id"] == "setting.tools.execution")));
        let execution = data["items"]
            .as_array()
            .and_then(|items| {
                items
                    .iter()
                    .find(|item| item["capabilityId"] == "setting.tools.execution")
            })
            .expect("execution capability result");
        assert_eq!(execution["nextAction"]["action"], "get");
        assert_eq!(
            execution["nextAction"]["capabilityId"],
            "setting.tools.execution"
        );
        assert_eq!(execution["nextToolCall"]["action"], "get");
        assert_eq!(
            execution["nextToolCall"]["capability_id"],
            "setting.tools.execution"
        );
        let matched_item = execution["matchedItems"]
            .as_array()
            .and_then(|items| items.iter().find(|item| item["itemId"] == "deferred-tools"))
            .expect("deferred-tools match");
        assert_eq!(matched_item["capabilityId"], "setting.tools.execution");
        let assistant = result_for_assistant.as_deref().unwrap();
        assert!(assistant.contains("capabilityId"));
        assert!(assistant.contains("capability_id"));
        assert!(assistant.contains("itemId"));
        assert!(assistant.contains("setting.tools.execution"));
        assert!(assistant.contains("deferred-tools"));
        assert!(!assistant.contains("returned 1 item(s)"));
    }

    #[tokio::test]
    async fn headless_tool_configures_and_reads_back_shared_product_config() {
        assert!(!openbitfun_control_host_available());
        let (tool, _dir) = tool_with_temp_config("openbitfun-control-tool-round-trip").await;

        let configured = tool
            .call_impl(
                &json!({
                    "action": "configure",
                    "capabilityId": "setting.tools.execution",
                    "optionId": "deferred-tool-loading",
                    "value_boolean": false
                }),
                &context(),
            )
            .await
            .unwrap();
        let ToolResult::Result {
            data,
            result_for_assistant,
            ..
        } = &configured[0]
        else {
            panic!("expected a structured product-control result");
        };
        assert_eq!(data["effectiveValue"], false);
        assert_eq!(data["adapter"], "shared-config");
        assert!(result_for_assistant
            .as_deref()
            .is_some_and(|assistant| assistant.contains("effectiveValue")));

        let inspected = tool
            .call_impl(
                &json!({
                    "action": "get",
                    "capability_id": "setting.tools.execution"
                }),
                &context(),
            )
            .await
            .unwrap();
        let ToolResult::Result {
            data,
            result_for_assistant,
            ..
        } = &inspected[0]
        else {
            panic!("expected a structured product-control result");
        };
        assert_eq!(data["currentOptionValues"]["deferred-tool-loading"], false);
        assert_eq!(data["controlAvailability"]["adapter"], "shared-config");
        assert_eq!(
            data["toolInput"]["capability_id"],
            "setting.tools.execution"
        );
        let assistant = result_for_assistant.as_deref().unwrap();
        assert!(assistant.contains("deferred-tool-loading"));
        assert!(assistant.contains("currentOptionValues"));
    }

    #[tokio::test]
    async fn headless_mutations_reject_invalid_values_and_serialize_concurrent_updates() {
        assert!(!openbitfun_control_host_available());
        let (tool, _dir) = tool_with_temp_config("openbitfun-control-tool-transaction").await;

        let invalid = tool
            .call_impl(
                &json!({
                    "action": "configure",
                    "capability_id": "setting.tools.execution",
                    "option_id": "subagent-max-concurrency",
                    "value_integer": 1000
                }),
                &context(),
            )
            .await
            .unwrap_err();
        assert!(invalid.to_string().contains("value must be at most 32"));

        let first_context = context();
        let second_context = context();
        let first_request = json!({
            "action": "configure",
            "capability_id": "setting.tools.execution",
            "option_id": "subagent-max-concurrency",
            "value_integer": 7
        });
        let second_request = json!({
            "action": "configure",
            "capability_id": "setting.tools.execution",
            "option_id": "subagent-max-concurrency",
            "value_integer": 9
        });
        let (first, second) = tokio::join!(
            tool.call_impl(&first_request, &first_context),
            tool.call_impl(&second_request, &second_context)
        );
        let mut outcomes = [first.unwrap(), second.unwrap()]
            .into_iter()
            .map(|results| match &results[0] {
                ToolResult::Result { data, .. } => (
                    data["revision"].as_u64().unwrap(),
                    data["effectiveValue"].as_u64().unwrap(),
                ),
                _ => panic!("expected product-control result"),
            })
            .collect::<Vec<_>>();
        outcomes.sort_by_key(|(revision, _)| *revision);
        assert_eq!(
            outcomes
                .iter()
                .map(|(revision, _)| *revision)
                .collect::<Vec<_>>(),
            vec![1, 2]
        );

        let inspected = tool
            .call_impl(
                &json!({
                    "action": "get",
                    "capability_id": "setting.tools.execution"
                }),
                &context(),
            )
            .await
            .unwrap();
        let ToolResult::Result { data, .. } = &inspected[0] else {
            panic!("expected a structured product-control result");
        };
        assert_eq!(
            data["currentOptionValues"]["subagent-max-concurrency"],
            outcomes[1].1
        );
        assert_eq!(data["revision"], 2);
    }

    #[test]
    fn discovery_is_permission_free_but_execution_is_scoped() {
        let tool = OpenBitFunControlTool::new();
        assert!(tool
            .permission_intents(&json!({ "action": "search", "query": "theme" }), &context())
            .unwrap()
            .is_empty());
        let intents = tool
            .permission_intents(
                &json!({
                    "action": "configure",
                    "capability_id": "setting.application.general",
                    "option_id": "auto-update",
                    "value": false
                }),
                &context(),
            )
            .unwrap();
        assert_eq!(intents[0].action, "openbitfun_control");
        assert_eq!(
            intents[0].resources,
            vec!["configure:setting.application.general:auto-update"]
        );

        let open_intents = tool
            .permission_intents(
                &json!({
                    "action": "open",
                    "capability_id": "setting.application.shortcuts",
                    "item_id": "shortcut-browser"
                }),
                &context(),
            )
            .unwrap();
        assert_eq!(
            open_intents[0].resources,
            vec!["open:setting.application.shortcuts:shortcut-browser"]
        );

        let read_operation = json!({
            "action": "execute",
            "capability_id": "setting.application.pet",
            "operation_id": "list-pets"
        });
        assert!(OpenBitFunControlTool::operation_is_readonly(
            &read_operation
        ));
        assert!(tool
            .permission_intents(&read_operation, &context())
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn headless_profiles_discover_contracts_and_degrade_control_explicitly() {
        assert!(!openbitfun_control_host_available());
        let tool = OpenBitFunControlTool::new();
        let results = tool
            .call_impl(
                &json!({
                    "action": "get",
                    "capability_id": "setting.application.pet"
                }),
                &context(),
            )
            .await
            .unwrap();
        let ToolResult::Result { data, .. } = &results[0] else {
            panic!("expected a structured product-control result");
        };
        assert_eq!(data["controlAvailability"]["status"], "unavailable");
        assert_eq!(data["controlAvailability"]["contractAvailable"], true);
        assert_eq!(
            data["nextToolCalls"]["openCapabilityRoot"]["action"],
            "open"
        );
        assert_eq!(
            data["nextToolCalls"]["openCapabilityRoot"]["capability_id"],
            "setting.application.pet"
        );
        assert_eq!(
            data["idNamespaceRules"]["destinationActionIdCallable"],
            false
        );

        let error = tool
            .call_impl(
                &json!({
                    "action": "execute",
                    "capability_id": "setting.application.pet",
                    "operation_id": "list-pets"
                }),
                &context(),
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("unsupported[profile=headless]"));
    }

    #[tokio::test]
    async fn remote_workspaces_reject_product_host_paths_but_allow_stable_ids() {
        let tool = OpenBitFunControlTool::new();
        let path_request = json!({
            "action": "execute",
            "capability_id": "setting.application.pet",
            "operation_id": "use-pet",
            "arguments": { "path": "/remote/workspace/petdex" }
        });
        let remote = remote_context();
        let validation = tool.validate_input(&path_request, Some(&remote)).await;
        assert!(!validation.result);
        assert!(validation
            .message
            .as_deref()
            .is_some_and(|message| message.contains("product-host path")));

        let id_request = json!({
            "action": "execute",
            "capability_id": "setting.application.pet",
            "operation_id": "use-pet",
            "arguments": { "id": "openbitfun" }
        });
        assert!(tool.validate_input(&id_request, Some(&remote)).await.result);
    }
}
