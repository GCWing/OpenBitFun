use crate::tool_snapshot::{
    materialize_tool_snapshot, MaterializedToolSnapshot, ToolProviderIdentity,
};
use crate::{
    DynamicToolDescriptor, DynamicToolProvider, PortError, PortErrorKind, PortResult,
    ToolDecorator, CALL_DEFERRED_TOOL_NAME,
};
use async_trait::async_trait;
use indexmap::IndexMap;
use openbitfun_core_types::ToolImageAttachment;
use openbitfun_runtime_ports::DelegationPolicy;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fmt;
use std::marker::PhantomData;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Dynamic MCP tool subtype metadata.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DynamicMcpToolInfo {
    pub server_id: String,
    pub server_name: String,
    pub tool_name: String,
}

/// Dynamic tool provider metadata used by registry and boundary adapters.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DynamicToolInfo {
    pub provider_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp: Option<DynamicMcpToolInfo>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ToolWorkspaceKind {
    Local,
    Remote,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolContextFacts {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dialog_turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_kind: Option<ToolWorkspaceKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_root: Option<String>,
    #[serde(default)]
    pub runtime_tool_restrictions: ToolRuntimeRestrictions,
}

pub trait PortableToolContextProvider: Send + Sync {
    fn tool_context_facts(&self) -> ToolContextFacts;
}

pub const GET_TOOL_SPEC_TOOL_NAME: &str = "GetToolSpec";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeferredToolUsageError {
    RequiresGetToolSpec {
        tool_name: String,
        get_tool_spec_tool_name: String,
    },
    StaleSpec {
        tool_name: String,
        loaded_generation: u64,
        current_generation: u64,
        get_tool_spec_tool_name: String,
    },
}

impl fmt::Display for DeferredToolUsageError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RequiresGetToolSpec {
                tool_name,
                get_tool_spec_tool_name,
            } => write!(
                formatter,
                "Tool '{tool_name}' has no loaded definition in the current context. Call {get_tool_spec_tool_name} with {{\"tool_name\":\"{tool_name}\"}} to read its full usage instructions and input schema before invoking it. If compaction removed an earlier definition, reload it even if the summary says it was loaded."
            ),
            Self::StaleSpec {
                tool_name,
                loaded_generation,
                current_generation,
                get_tool_spec_tool_name,
            } => write!(
                formatter,
                "The loaded spec for deferred tool '{tool_name}' is stale (loaded catalog generation {loaded_generation}, current generation {current_generation}). Call {get_tool_spec_tool_name} again before invoking it."
            ),
        }
    }
}

impl std::error::Error for DeferredToolUsageError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolExecutionAccessError {
    NotInAllowedList {
        tool_name: String,
        allowed_tools: Vec<String>,
    },
}

impl fmt::Display for ToolExecutionAccessError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotInAllowedList {
                tool_name,
                allowed_tools,
            } => write!(
                formatter,
                "Tool '{tool_name}' is not in the allowed list: {allowed_tools:?}"
            ),
        }
    }
}

impl std::error::Error for ToolExecutionAccessError {}

pub fn validate_tool_allowed_by_list(
    tool_name: &str,
    allowed_tools: &[String],
) -> Result<(), ToolExecutionAccessError> {
    if allowed_tools.is_empty() || allowed_tools.iter().any(|allowed| allowed == tool_name) {
        return Ok(());
    }

    Err(ToolExecutionAccessError::NotInAllowedList {
        tool_name: tool_name.to_string(),
        allowed_tools: allowed_tools.to_vec(),
    })
}

pub fn validate_deferred_tool_usage(
    tool_name: &str,
    deferred_tools: &[String],
    loaded_deferred_tool_specs: &[LoadedDeferredToolSpec],
    current_catalog_generation: u64,
    get_tool_spec_tool_name: &str,
) -> Result<(), DeferredToolUsageError> {
    if tool_name == get_tool_spec_tool_name {
        return Ok(());
    }

    if !deferred_tools
        .iter()
        .any(|deferred_tool| deferred_tool == tool_name)
    {
        return Ok(());
    }

    if let Some(loaded) = loaded_deferred_tool_specs
        .iter()
        .find(|loaded| loaded.tool_name == tool_name)
    {
        if loaded.catalog_generation == current_catalog_generation {
            return Ok(());
        }
        return Err(DeferredToolUsageError::StaleSpec {
            tool_name: tool_name.to_string(),
            loaded_generation: loaded.catalog_generation,
            current_generation: current_catalog_generation,
            get_tool_spec_tool_name: get_tool_spec_tool_name.to_string(),
        });
    }

    Err(DeferredToolUsageError::RequiresGetToolSpec {
        tool_name: tool_name.to_string(),
        get_tool_spec_tool_name: get_tool_spec_tool_name.to_string(),
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ToolExposure {
    Direct,
    Deferred,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolManifestDefinition {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

impl ToolManifestDefinition {
    pub fn new(name: impl Into<String>, description: impl Into<String>, parameters: Value) -> Self {
        Self {
            name: name.into(),
            description: description.into(),
            parameters,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum PromptVisibleToolManifestItem {
    Direct(ToolManifestDefinition),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolManifestPolicyTool {
    pub name: String,
    pub default_exposure: ToolExposure,
    pub available: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolManifestPolicyResolution {
    pub allowed_tool_names: Vec<String>,
    pub direct_tool_names: Vec<String>,
    pub deferred_tool_names: Vec<String>,
}

#[derive(Clone)]
pub struct ContextualVisibleTools<Tool: ?Sized> {
    pub allowed_tool_names: Vec<String>,
    pub direct_tools: Vec<ToolRef<Tool>>,
    pub deferred_tool_names: Vec<String>,
    pub deferred_tools: Vec<ToolRef<Tool>>,
}

#[derive(Clone)]
pub struct ContextualToolManifest<Tool: ?Sized> {
    pub allowed_tool_names: Vec<String>,
    pub direct_tools: Vec<ToolRef<Tool>>,
    pub deferred_tool_names: Vec<String>,
    pub deferred_tools: Vec<ToolRef<Tool>>,
    pub tool_definitions: Vec<ToolManifestDefinition>,
}

pub fn resolve_tool_manifest_policy(
    tool_snapshot: &[ToolManifestPolicyTool],
    allowed_tools: &[String],
    exposure_overrides: &IndexMap<String, ToolExposure>,
    get_tool_spec_tool_name: &str,
) -> ToolManifestPolicyResolution {
    let allowed_set = allowed_tools
        .iter()
        .map(String::as_str)
        .collect::<std::collections::HashSet<_>>();
    let mut allowed_tool_names = allowed_tools.to_vec();
    let mut direct_tool_names = Vec::new();
    let mut deferred_tool_names = Vec::new();

    for tool in tool_snapshot {
        if !tool.available || !allowed_set.contains(tool.name.as_str()) {
            continue;
        }

        let exposure = exposure_overrides
            .get(&tool.name)
            .copied()
            .unwrap_or(tool.default_exposure);
        match exposure {
            ToolExposure::Direct => direct_tool_names.push(tool.name.clone()),
            ToolExposure::Deferred => deferred_tool_names.push(tool.name.clone()),
        }
    }

    if !deferred_tool_names.is_empty() {
        for gateway_name in [get_tool_spec_tool_name, CALL_DEFERRED_TOOL_NAME] {
            if !allowed_tool_names.iter().any(|name| name == gateway_name) {
                allowed_tool_names.push(gateway_name.to_string());
            }
            if tool_snapshot.iter().any(|tool| tool.name == gateway_name)
                && !direct_tool_names.iter().any(|name| name == gateway_name)
            {
                direct_tool_names.push(gateway_name.to_string());
            }
        }
    }

    ToolManifestPolicyResolution {
        allowed_tool_names,
        direct_tool_names,
        deferred_tool_names,
    }
}

pub fn build_tool_manifest_policy_tools<Tool: ToolRegistryItem + ?Sized>(
    tool_snapshot: &[ToolRef<Tool>],
    available_tool_names: &HashSet<String>,
) -> Vec<ToolManifestPolicyTool> {
    tool_snapshot
        .iter()
        .map(|tool| {
            let name = tool.name().to_string();
            ToolManifestPolicyTool {
                available: available_tool_names.contains(&name),
                default_exposure: tool.default_exposure(),
                name,
            }
        })
        .collect()
}

fn tools_by_name<Tool: ToolRegistryItem + ?Sized>(
    tool_snapshot: &[ToolRef<Tool>],
    tool_names: &[String],
) -> Vec<ToolRef<Tool>> {
    tool_names
        .iter()
        .filter_map(|name| {
            tool_snapshot
                .iter()
                .find(|tool| tool.name() == name)
                .cloned()
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GetToolSpecDeferredToolSummary {
    pub name: String,
    pub short_description: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GetToolSpecDetail {
    pub tool_name: String,
    pub description: String,
    pub input_schema: Value,
    pub catalog_generation: u64,
}

impl GetToolSpecDetail {
    pub fn to_value(&self) -> Value {
        serde_json::json!({
            "tool_name": self.tool_name.clone(),
            "description": self.description.clone(),
            "input_schema": self.input_schema.clone(),
            "catalog_generation": self.catalog_generation,
        })
    }
}

pub fn get_tool_spec_input_schema() -> Value {
    serde_json::json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["tool_name"],
        "properties": {
            "tool_name": {
                "type": "string",
                "description": "Exact deferred tool name to load, using the tool's canonical casing from the catalog (for example, \"WebFetch\"). Do not pass a URL or an operation name here."
            }
        }
    })
}

pub fn get_tool_spec_short_description() -> String {
    "Discover deferred tools and read their detailed definitions.".to_string()
}

pub fn build_get_tool_spec_description() -> String {
    r#"Read the full schema before first calling a deferred tool through CallDeferredTool.

Do not call GetToolSpec again while its successful result with the full definition is still visible in the current context.
If compaction or truncation removed that result, call GetToolSpec again before using CallDeferredTool. A summary mentioning a previously loaded tool or a past successful call does not load its definition. Reload also when the runtime reports a stale definition."#
        .to_string()
}

pub fn build_get_tool_spec_catalog_description(
    deferred_tools: &[GetToolSpecDeferredToolSummary],
) -> Option<String> {
    if deferred_tools.is_empty() {
        return None;
    }

    let deferred_tools_list = deferred_tools
        .iter()
        .map(|tool| match tool.short_description.as_deref() {
            Some(description) if !description.trim().is_empty() => {
                format!("- {}: {}", tool.name, description)
            }
            _ => format!("- {}", tool.name),
        })
        .collect::<Vec<_>>()
        .join("\n");

    Some(format!(
        "<deferred_tools>\n{}\n</deferred_tools>",
        deferred_tools_list
    ))
}

pub fn get_tool_spec_is_readonly() -> bool {
    true
}

pub fn get_tool_spec_is_concurrency_safe(_input: Option<&Value>) -> bool {
    true
}

pub fn render_get_tool_spec_tool_use_message(input: &Value) -> String {
    let tool_name = input
        .get("tool_name")
        .and_then(|value| value.as_str())
        .unwrap_or("?");
    format!("Reading tool spec for '{}'.", tool_name)
}

pub fn validate_get_tool_spec_input(input: &Value) -> ValidationResult {
    let Some(tool_name) = input.get("tool_name").and_then(|value| value.as_str()) else {
        return ValidationResult {
            result: false,
            message: Some("tool_name is required and cannot be empty".to_string()),
            error_code: Some(400),
            meta: None,
        };
    };

    if tool_name.is_empty() {
        return ValidationResult {
            result: false,
            message: Some("tool_name is required and cannot be empty".to_string()),
            error_code: Some(400),
            meta: None,
        };
    }

    ValidationResult::default()
}

pub fn build_get_tool_spec_duplicate_load_hint(tool_name: &str) -> String {
    format!(
        "Tool '{}' is already loaded in the current context. Use CallDeferredTool with tool_name '{}' and put the tool arguments inside args. Reload with GetToolSpec only if its full definition leaves the context or the runtime reports it stale.",
        tool_name, tool_name
    )
}

pub fn build_get_tool_spec_duplicate_load_result(tool_name: &str) -> ToolResult {
    ToolResult::Result {
        data: serde_json::json!({
            "tool_name": tool_name,
            "already_loaded": true
        }),
        result_for_assistant: Some(build_get_tool_spec_duplicate_load_hint(tool_name)),
        image_attachments: None,
    }
}

pub fn build_get_tool_spec_already_available_hint(tool_name: &str) -> String {
    format!(
        "Tool '{}' is already fully defined in the available tool list. Use '{}' directly.",
        tool_name, tool_name
    )
}

pub fn build_get_tool_spec_already_available_result(tool_name: &str) -> ToolResult {
    ToolResult::Result {
        data: serde_json::json!({
            "tool_name": tool_name,
            "already_available": true
        }),
        result_for_assistant: Some(build_get_tool_spec_already_available_hint(tool_name)),
        image_attachments: None,
    }
}

pub fn build_get_tool_spec_unavailable_deferred_hint(tool_name: &str) -> String {
    format!("'{}' is not available in the current context", tool_name)
}

pub fn build_get_tool_spec_unavailable_deferred_result(tool_name: &str) -> ToolResult {
    ToolResult::Result {
        data: serde_json::json!({
            "tool_name": tool_name,
            "available_deferred_tool": false
        }),
        result_for_assistant: Some(build_get_tool_spec_unavailable_deferred_hint(tool_name)),
        image_attachments: None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GetToolSpecExecutionError {
    MissingToolName,
    Detail(String),
}

impl fmt::Display for GetToolSpecExecutionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            GetToolSpecExecutionError::MissingToolName => write!(f, "tool_name is required"),
            GetToolSpecExecutionError::Detail(message) => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for GetToolSpecExecutionError {}

#[derive(Debug, Clone)]
pub enum GetToolSpecExecutionPlan<'a> {
    DuplicateLoad(ToolResult),
    LoadDetail { tool_name: &'a str },
}

pub fn resolve_get_tool_spec_execution_plan<'a>(
    input: &'a Value,
    loaded_deferred_tool_names: &[String],
) -> Result<GetToolSpecExecutionPlan<'a>, GetToolSpecExecutionError> {
    let tool_name = input
        .get("tool_name")
        .and_then(|value| value.as_str())
        .ok_or(GetToolSpecExecutionError::MissingToolName)?;

    if loaded_deferred_tool_names
        .iter()
        .any(|loaded| loaded == tool_name)
    {
        return Ok(GetToolSpecExecutionPlan::DuplicateLoad(
            build_get_tool_spec_duplicate_load_result(tool_name),
        ));
    }

    Ok(GetToolSpecExecutionPlan::LoadDetail { tool_name })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GetToolSpecLoadObservation<'a> {
    pub tool_name: &'a str,
    pub loaded_tool_name: Option<&'a str>,
    pub catalog_generation: Option<u64>,
    pub is_error: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadedDeferredToolSpec {
    pub tool_name: String,
    pub catalog_generation: u64,
}

pub fn collect_loaded_deferred_tool_specs(
    observations: &[GetToolSpecLoadObservation<'_>],
    deferred_tool_names: &[String],
    get_tool_spec_tool_name: &str,
) -> Vec<LoadedDeferredToolSpec> {
    let deferred_set: HashSet<&str> = deferred_tool_names.iter().map(String::as_str).collect();
    let mut loaded = BTreeMap::new();

    for observation in observations {
        if observation.is_error || observation.tool_name != get_tool_spec_tool_name {
            continue;
        }

        let Some(tool_name) = observation.loaded_tool_name else {
            continue;
        };

        if deferred_set.contains(tool_name) {
            if let Some(catalog_generation) = observation.catalog_generation {
                loaded.insert(
                    tool_name.to_string(),
                    LoadedDeferredToolSpec {
                        tool_name: tool_name.to_string(),
                        catalog_generation,
                    },
                );
            }
        }
    }

    loaded.into_values().collect()
}

pub fn build_get_tool_spec_assistant_detail(
    tool_name: &str,
    description: &str,
    input_schema: &Value,
) -> String {
    let calling_schema = build_deferred_tool_calling_schema(tool_name, input_schema);
    format!(
        "<description>\n{}\n</description>\n<calling>\nCall `CallDeferredTool` with arguments matching this schema:\n{}\n</calling>",
        escape_get_tool_spec_xml_text(description),
        escape_get_tool_spec_xml_text(&calling_schema),
    )
}

fn build_deferred_tool_calling_schema(tool_name: &str, input_schema: &Value) -> String {
    let tool_name = serde_json::to_string(tool_name).unwrap_or_else(|_| "\"\"".to_string());
    let input_schema =
        serde_json::to_string_pretty(input_schema).unwrap_or_else(|_| input_schema.to_string());
    let input_schema = indent_following_lines(&input_schema, "    ");

    format!(
        "{{\n  \"type\": \"object\",\n  \"additionalProperties\": false,\n  \"required\": [\"tool_name\", \"args\"],\n  \"properties\": {{\n    \"tool_name\": {{\n      \"const\": {tool_name}\n    }},\n    \"args\": {input_schema}\n  }}\n}}"
    )
}

fn indent_following_lines(value: &str, indentation: &str) -> String {
    let mut lines = value.lines();
    let Some(first) = lines.next() else {
        return String::new();
    };
    let mut indented = first.to_string();
    for line in lines {
        indented.push('\n');
        indented.push_str(indentation);
        indented.push_str(line);
    }
    indented
}

pub fn build_get_tool_spec_detail_result(detail: &GetToolSpecDetail) -> ToolResult {
    ToolResult::Result {
        data: detail.to_value(),
        result_for_assistant: Some(build_get_tool_spec_assistant_detail(
            &detail.tool_name,
            &detail.description,
            &detail.input_schema,
        )),
        image_attachments: None,
    }
}

fn escape_get_tool_spec_xml_text(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

pub fn tool_manifest_sort_rank(tool_name: &str) -> usize {
    match tool_name {
        "AgentSpawn" => 1,
        "AgentSendInput" => 1,
        "AgentControl" => 1,
        "AgentWait" => 1,
        "ExecCommand" => 2,
        "Glob" => 4,
        "Grep" => 5,
        "Read" => 6,
        "Edit" => 7,
        "Write" => 8,
        "Delete" => 9,
        "WebFetch" => 10,
        "WebSearch" => 11,
        "TodoWrite" => 12,
        "Skill" => 13,
        GET_TOOL_SPEC_TOOL_NAME => 15,
        "ControlHub" => 16,
        _ => 100,
    }
}

pub fn sort_tool_manifest_definitions(tool_definitions: &mut [ToolManifestDefinition]) {
    tool_definitions.sort_by_key(|tool| tool_manifest_sort_rank(&tool.name));
}

pub fn build_prompt_visible_tool_manifest_definitions(
    items: &[PromptVisibleToolManifestItem],
) -> Vec<ToolManifestDefinition> {
    let mut definitions = items
        .iter()
        .map(|item| match item {
            PromptVisibleToolManifestItem::Direct(definition) => definition.clone(),
        })
        .collect::<Vec<_>>();
    sort_tool_manifest_definitions(&mut definitions);
    definitions
}

#[async_trait]
pub trait ToolRegistryItem: Send + Sync {
    fn name(&self) -> &str;

    async fn description(&self) -> Result<String, String>;

    fn input_schema(&self) -> Value;

    fn short_description(&self) -> String {
        self.name().to_string()
    }

    fn default_exposure(&self) -> ToolExposure {
        ToolExposure::Direct
    }

    fn is_readonly(&self) -> bool {
        false
    }

    fn is_concurrency_safe(&self, _input: Option<&Value>) -> bool {
        self.is_readonly()
    }

    fn manages_own_execution_timeout(&self) -> bool {
        false
    }

    async fn is_enabled(&self) -> bool {
        true
    }

    async fn input_schema_for_model(&self) -> Value {
        self.input_schema()
    }

    fn dynamic_provider_id(&self) -> Option<&str> {
        None
    }

    fn dynamic_tool_info(&self) -> Option<DynamicToolInfo> {
        self.dynamic_provider_id()
            .map(|provider_id| DynamicToolInfo {
                provider_id: provider_id.to_string(),
                provider_kind: None,
                mcp: None,
            })
    }
}

#[async_trait]
pub trait ContextualToolManifestItem<Context>: ToolRegistryItem
where
    Context: Sync,
{
    async fn is_available_in_context(&self, _context: &Context) -> bool {
        true
    }

    /// Return the tool description that will be sent to the AI provider.
    ///
    /// # Prefix-cache stability contract
    ///
    /// The byte output of this method must be identical across every round of
    /// the same session for the same logical tool configuration. Any variation
    /// in the returned string invalidates the provider-side prefix cache for
    /// all bytes that follow the tool-spec block, which can significantly
    /// increase per-round cost.
    ///
    /// Acceptable variation:
    /// - Remote vs local workspace, which changes at session start and then stays stable.
    /// - Model capability flags such as vision support, which are stable per session.
    /// - User-initiated config changes such as theme or locale.
    ///
    /// Forbidden variation:
    /// - Timestamps, request IDs, UUIDs, or any non-deterministic data.
    /// - Session-specific paths that change mid-session.
    /// - Anything that varies between API calls within the same session.
    async fn description_with_context(&self, _context: &Context) -> Result<String, String> {
        self.description().await
    }

    /// Return the JSON schema sent to the AI provider.
    ///
    /// Subject to the same prefix-cache stability contract as
    /// [`Self::description_with_context`]: output must be byte-stable across
    /// rounds of the same session for the same tool configuration.
    async fn input_schema_for_model_with_context(&self, _context: &Context) -> Value {
        self.input_schema_for_model().await
    }
}

#[async_trait]
pub trait ToolCatalogSnapshotProvider<Tool: ?Sized>: Send + Sync {
    async fn tool_snapshot(&self) -> Vec<ToolRef<Tool>>;
}

#[async_trait]
pub trait GetToolSpecCatalogProvider<Tool: ?Sized, Context>: Send + Sync
where
    Context: Sync,
{
    async fn deferred_tools_for_get_tool_spec(
        &self,
        context: Option<&Context>,
    ) -> Result<Vec<ToolRef<Tool>>, String>;

    async fn catalog_generation(&self) -> u64 {
        0
    }

    async fn available_tools_for_get_tool_spec(
        &self,
        context: Option<&Context>,
    ) -> Result<Vec<ToolRef<Tool>>, String> {
        self.deferred_tools_for_get_tool_spec(context).await
    }
}

pub fn summarize_get_tool_spec_deferred_tools<Tool: ToolRegistryItem + ?Sized>(
    deferred_tools: &[ToolRef<Tool>],
) -> Vec<GetToolSpecDeferredToolSummary> {
    deferred_tools
        .iter()
        .map(|tool| GetToolSpecDeferredToolSummary {
            name: tool.name().to_string(),
            short_description: match tool.dynamic_tool_info() {
                Some(info) if info.mcp.is_some() => None,
                _ => Some(tool.short_description()),
            },
        })
        .collect()
}

pub async fn build_get_tool_spec_catalog_description_from_provider<Tool, Context, Provider>(
    provider: &Provider,
    context: Option<&Context>,
) -> Result<Option<String>, String>
where
    Tool: ToolRegistryItem + ?Sized,
    Context: Sync,
    Provider: GetToolSpecCatalogProvider<Tool, Context> + ?Sized,
{
    let deferred_tools = provider.deferred_tools_for_get_tool_spec(context).await?;
    let summaries = summarize_get_tool_spec_deferred_tools(&deferred_tools);
    Ok(build_get_tool_spec_catalog_description(&summaries))
}

pub async fn resolve_readonly_enabled_tools<Tool: ToolRegistryItem + ?Sized>(
    tool_snapshot: &[ToolRef<Tool>],
) -> Vec<ToolRef<Tool>> {
    let mut readonly_tools = Vec::new();

    for tool in tool_snapshot {
        if tool.is_readonly() && tool.is_enabled().await {
            readonly_tools.push(tool.clone());
        }
    }

    readonly_tools
}

pub struct ToolCatalogRuntime<'a, Tool: ?Sized, Context, Provider: ?Sized> {
    provider: &'a Provider,
    get_tool_spec_tool_name: &'a str,
    _marker: PhantomData<fn(&Tool, &Context)>,
}

impl<'a, Tool: ?Sized, Context, Provider: ?Sized> ToolCatalogRuntime<'a, Tool, Context, Provider> {
    pub fn new(provider: &'a Provider, get_tool_spec_tool_name: &'a str) -> Self {
        Self {
            provider,
            get_tool_spec_tool_name,
            _marker: PhantomData,
        }
    }
}

impl<'a, Tool, Context, Provider> ToolCatalogRuntime<'a, Tool, Context, Provider>
where
    Tool: ToolRegistryItem + ?Sized,
    Provider: ToolCatalogSnapshotProvider<Tool> + ?Sized,
{
    pub async fn readonly_enabled_tools(&self) -> Vec<ToolRef<Tool>> {
        let tool_snapshot = self.provider.tool_snapshot().await;
        resolve_readonly_enabled_tools(&tool_snapshot).await
    }
}

impl<'a, Tool, Context, Provider> ToolCatalogRuntime<'a, Tool, Context, Provider>
where
    Tool: ContextualToolManifestItem<Context> + ?Sized,
    Context: Sync,
    Provider: ToolCatalogSnapshotProvider<Tool> + ?Sized,
{
    pub async fn visible_tools(
        &self,
        allowed_tools: &[String],
        exposure_overrides: &IndexMap<String, ToolExposure>,
        context: &Context,
    ) -> ContextualVisibleTools<Tool> {
        resolve_contextual_visible_tools_from_provider(
            self.provider,
            allowed_tools,
            exposure_overrides,
            context,
            self.get_tool_spec_tool_name,
        )
        .await
    }

    pub async fn tool_manifest(
        &self,
        allowed_tools: &[String],
        exposure_overrides: &IndexMap<String, ToolExposure>,
        context: &Context,
    ) -> ContextualToolManifest<Tool> {
        resolve_contextual_tool_manifest_from_provider(
            self.provider,
            allowed_tools,
            exposure_overrides,
            context,
            self.get_tool_spec_tool_name,
        )
        .await
    }
}

pub async fn resolve_get_tool_spec_detail<Tool, Context>(
    deferred_tools: &[ToolRef<Tool>],
    tool_name: &str,
    context: &Context,
    get_tool_spec_tool_name: &str,
) -> Result<GetToolSpecDetail, String>
where
    Tool: ContextualToolManifestItem<Context> + ?Sized,
    Context: Sync,
{
    let tool = deferred_tools
        .iter()
        .find(|tool| tool.name() == tool_name)
        .ok_or_else(|| format!("'{tool_name}' is not available in the current context"))?;

    if tool.name() == get_tool_spec_tool_name {
        return Err(format!("Tool '{tool_name}' cannot inspect itself"));
    }

    let description = tool
        .description_with_context(context)
        .await
        .unwrap_or_else(|_| format!("Tool: {}", tool.name()));
    let input_schema = tool.input_schema_for_model_with_context(context).await;

    Ok(GetToolSpecDetail {
        tool_name: tool_name.to_string(),
        description,
        input_schema,
        catalog_generation: 0,
    })
}

pub async fn resolve_get_tool_spec_detail_from_provider<Tool, Context, Provider>(
    provider: &Provider,
    tool_name: &str,
    context: &Context,
    get_tool_spec_tool_name: &str,
) -> Result<GetToolSpecDetail, String>
where
    Tool: ContextualToolManifestItem<Context> + ?Sized,
    Context: Sync,
    Provider: GetToolSpecCatalogProvider<Tool, Context> + ?Sized,
{
    let deferred_tools = provider
        .deferred_tools_for_get_tool_spec(Some(context))
        .await?;
    resolve_get_tool_spec_detail(&deferred_tools, tool_name, context, get_tool_spec_tool_name).await
}

pub async fn resolve_get_tool_spec_execution_result_from_provider<Tool, Context, Provider>(
    provider: &Provider,
    input: &Value,
    loaded_deferred_tool_specs: &[LoadedDeferredToolSpec],
    context: &Context,
    get_tool_spec_tool_name: &str,
) -> Result<ToolResult, GetToolSpecExecutionError>
where
    Tool: ContextualToolManifestItem<Context> + ?Sized,
    Context: Sync,
    Provider: GetToolSpecCatalogProvider<Tool, Context> + ?Sized,
{
    let current_generation = provider.catalog_generation().await;
    let loaded_names = loaded_deferred_tool_specs
        .iter()
        .filter(|spec| spec.catalog_generation == current_generation)
        .map(|spec| spec.tool_name.clone())
        .collect::<Vec<_>>();
    match resolve_get_tool_spec_execution_plan(input, &loaded_names)? {
        GetToolSpecExecutionPlan::DuplicateLoad(result) => Ok(result),
        GetToolSpecExecutionPlan::LoadDetail { tool_name } => {
            let deferred_tools = provider
                .deferred_tools_for_get_tool_spec(Some(context))
                .await
                .map_err(GetToolSpecExecutionError::Detail)?;

            if deferred_tools.iter().any(|tool| tool.name() == tool_name) {
                let detail = resolve_get_tool_spec_detail(
                    &deferred_tools,
                    tool_name,
                    context,
                    get_tool_spec_tool_name,
                )
                .await
                .map_err(GetToolSpecExecutionError::Detail)?;
                let detail = GetToolSpecDetail {
                    catalog_generation: current_generation,
                    ..detail
                };
                return Ok(build_get_tool_spec_detail_result(&detail));
            }

            let available_tools = provider
                .available_tools_for_get_tool_spec(Some(context))
                .await
                .map_err(GetToolSpecExecutionError::Detail)?;
            if available_tools.iter().any(|tool| tool.name() == tool_name) {
                return Ok(build_get_tool_spec_already_available_result(tool_name));
            }

            Ok(build_get_tool_spec_unavailable_deferred_result(tool_name))
        }
    }
}

pub struct GetToolSpecRuntime<'a, Tool: ?Sized, Context, Provider: ?Sized> {
    provider: &'a Provider,
    tool_name: &'a str,
    _marker: PhantomData<fn(&Tool, &Context)>,
}

impl<'a, Tool: ?Sized, Context, Provider: ?Sized> GetToolSpecRuntime<'a, Tool, Context, Provider> {
    pub fn new(provider: &'a Provider, tool_name: &'a str) -> Self {
        Self {
            provider,
            tool_name,
            _marker: PhantomData,
        }
    }

    pub fn name(&self) -> &str {
        self.tool_name
    }

    pub fn short_description(&self) -> String {
        get_tool_spec_short_description()
    }

    pub fn input_schema(&self) -> Value {
        get_tool_spec_input_schema()
    }

    pub fn is_readonly(&self) -> bool {
        get_tool_spec_is_readonly()
    }

    pub fn is_concurrency_safe(&self, input: Option<&Value>) -> bool {
        get_tool_spec_is_concurrency_safe(input)
    }

    pub fn render_tool_use_message(&self, input: &Value) -> String {
        render_get_tool_spec_tool_use_message(input)
    }

    pub fn validate_input(&self, input: &Value) -> ValidationResult {
        validate_get_tool_spec_input(input)
    }
}

impl<'a, Tool, Context, Provider> GetToolSpecRuntime<'a, Tool, Context, Provider>
where
    Tool: ContextualToolManifestItem<Context> + ?Sized,
    Context: Sync,
    Provider: GetToolSpecCatalogProvider<Tool, Context> + ?Sized,
{
    pub async fn execute(
        &self,
        input: &Value,
        loaded_deferred_tool_specs: &[LoadedDeferredToolSpec],
        context: &Context,
    ) -> Result<ToolResult, GetToolSpecExecutionError> {
        resolve_get_tool_spec_execution_result_from_provider(
            self.provider,
            input,
            loaded_deferred_tool_specs,
            context,
            self.tool_name,
        )
        .await
    }

    pub async fn call_results(
        &self,
        input: &Value,
        loaded_deferred_tool_specs: &[LoadedDeferredToolSpec],
        context: &Context,
    ) -> Result<Vec<ToolResult>, GetToolSpecExecutionError> {
        self.execute(input, loaded_deferred_tool_specs, context)
            .await
            .map(|result| vec![result])
    }
}

pub async fn resolve_contextual_visible_tools_from_provider<Tool, Context, Provider>(
    provider: &Provider,
    allowed_tools: &[String],
    exposure_overrides: &IndexMap<String, ToolExposure>,
    context: &Context,
    get_tool_spec_tool_name: &str,
) -> ContextualVisibleTools<Tool>
where
    Tool: ContextualToolManifestItem<Context> + ?Sized,
    Context: Sync,
    Provider: ToolCatalogSnapshotProvider<Tool> + ?Sized,
{
    let tool_snapshot = provider.tool_snapshot().await;
    resolve_contextual_visible_tools(
        &tool_snapshot,
        allowed_tools,
        exposure_overrides,
        context,
        get_tool_spec_tool_name,
    )
    .await
}

pub async fn resolve_contextual_tool_manifest_from_provider<Tool, Context, Provider>(
    provider: &Provider,
    allowed_tools: &[String],
    exposure_overrides: &IndexMap<String, ToolExposure>,
    context: &Context,
    get_tool_spec_tool_name: &str,
) -> ContextualToolManifest<Tool>
where
    Tool: ContextualToolManifestItem<Context> + ?Sized,
    Context: Sync,
    Provider: ToolCatalogSnapshotProvider<Tool> + ?Sized,
{
    let tool_snapshot = provider.tool_snapshot().await;
    resolve_contextual_tool_manifest(
        &tool_snapshot,
        allowed_tools,
        exposure_overrides,
        context,
        get_tool_spec_tool_name,
    )
    .await
}

pub async fn resolve_contextual_visible_tools<Tool, Context>(
    tool_snapshot: &[ToolRef<Tool>],
    allowed_tools: &[String],
    exposure_overrides: &IndexMap<String, ToolExposure>,
    context: &Context,
    get_tool_spec_tool_name: &str,
) -> ContextualVisibleTools<Tool>
where
    Tool: ContextualToolManifestItem<Context> + ?Sized,
    Context: Sync,
{
    let mut available_tool_names = HashSet::new();
    for tool in tool_snapshot {
        if tool.is_available_in_context(context).await {
            available_tool_names.insert(tool.name().to_string());
        }
    }

    let policy_tools = build_tool_manifest_policy_tools(tool_snapshot, &available_tool_names);
    let policy = resolve_tool_manifest_policy(
        &policy_tools,
        allowed_tools,
        exposure_overrides,
        get_tool_spec_tool_name,
    );
    let direct_tools = tools_by_name(tool_snapshot, &policy.direct_tool_names);
    let deferred_tools = tools_by_name(tool_snapshot, &policy.deferred_tool_names);

    ContextualVisibleTools {
        allowed_tool_names: policy.allowed_tool_names,
        direct_tools,
        deferred_tool_names: policy.deferred_tool_names,
        deferred_tools,
    }
}

pub async fn resolve_contextual_tool_manifest<Tool, Context>(
    tool_snapshot: &[ToolRef<Tool>],
    allowed_tools: &[String],
    exposure_overrides: &IndexMap<String, ToolExposure>,
    context: &Context,
    get_tool_spec_tool_name: &str,
) -> ContextualToolManifest<Tool>
where
    Tool: ContextualToolManifestItem<Context> + ?Sized,
    Context: Sync,
{
    let visible_tools = resolve_contextual_visible_tools(
        tool_snapshot,
        allowed_tools,
        exposure_overrides,
        context,
        get_tool_spec_tool_name,
    )
    .await;

    let mut manifest_items = Vec::with_capacity(visible_tools.direct_tools.len());
    for tool in &visible_tools.direct_tools {
        let description = tool
            .description_with_context(context)
            .await
            .unwrap_or_else(|_| format!("Tool: {}", tool.name()));
        let parameters = tool.input_schema_for_model_with_context(context).await;

        manifest_items.push(PromptVisibleToolManifestItem::Direct(
            ToolManifestDefinition::new(tool.name().to_string(), description, parameters),
        ));
    }

    // This prompt-visible tool-definition list is part of the request prefix.
    // Once a turn starts, enrich deferred tools through GetToolSpec results
    // instead of mutating this list, or later rounds will lose prefix-cache
    // reuse even if the actual tool set is unchanged.
    let tool_definitions = build_prompt_visible_tool_manifest_definitions(&manifest_items);

    ContextualToolManifest {
        allowed_tool_names: visible_tools.allowed_tool_names,
        direct_tools: visible_tools.direct_tools,
        deferred_tool_names: visible_tools.deferred_tool_names,
        deferred_tools: visible_tools.deferred_tools,
        tool_definitions,
    }
}

#[derive(Debug, Clone)]
struct DynamicToolMetadata {
    info: DynamicToolInfo,
}

struct IdentityToolDecorator;

impl<Tool> ToolDecorator<Tool> for IdentityToolDecorator {
    fn decorate(&self, tool: Tool) -> Tool {
        tool
    }
}

pub type ToolRef<Tool> = Arc<Tool>;
pub type ToolDecoratorRef<Tool> = Arc<dyn ToolDecorator<ToolRef<Tool>>>;

pub trait SnapshotToolWrapper<Tool: ?Sized>: Send + Sync {
    fn wrap_for_snapshot_tracking(&self, tool: ToolRef<Tool>) -> ToolRef<Tool>;
}

pub type SnapshotToolWrapperRef<Tool> = Arc<dyn SnapshotToolWrapper<Tool>>;

pub struct SnapshotToolDecorator<Tool: ?Sized> {
    wrapper: SnapshotToolWrapperRef<Tool>,
}

impl<Tool: ?Sized> SnapshotToolDecorator<Tool> {
    pub fn new(wrapper: SnapshotToolWrapperRef<Tool>) -> Self {
        Self { wrapper }
    }
}

impl<Tool: ?Sized> ToolDecorator<ToolRef<Tool>> for SnapshotToolDecorator<Tool> {
    fn decorate(&self, tool: ToolRef<Tool>) -> ToolRef<Tool> {
        self.wrapper.wrap_for_snapshot_tracking(tool)
    }
}

pub trait StaticToolProvider<Tool: ?Sized>: Send + Sync {
    fn provider_id(&self) -> &'static str;

    fn tools(&self) -> Vec<ToolRef<Tool>>;
}

pub trait StaticToolProviderPlan {
    fn provider_id(&self) -> &'static str;

    fn tool_names(&self) -> &'static [&'static str];
}

pub trait StaticToolProviderFactory<Tool: ?Sized> {
    fn materialize_tool(&self, tool_name: &str) -> Option<ToolRef<Tool>>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StaticToolMaterializationError {
    UnknownTool {
        provider_id: &'static str,
        tool_name: &'static str,
    },
}

impl std::fmt::Display for StaticToolMaterializationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnknownTool {
                provider_id,
                tool_name,
            } => write!(
                f,
                "unknown static tool {tool_name} in provider group {provider_id}"
            ),
        }
    }
}

impl std::error::Error for StaticToolMaterializationError {}

pub struct StaticToolProviderGroup<Tool: ?Sized> {
    provider_id: &'static str,
    tools: Vec<ToolRef<Tool>>,
}

impl<Tool: ?Sized> std::fmt::Debug for StaticToolProviderGroup<Tool> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StaticToolProviderGroup")
            .field("provider_id", &self.provider_id)
            .field("tool_count", &self.tools.len())
            .finish()
    }
}

impl<Tool: ?Sized> StaticToolProviderGroup<Tool> {
    pub fn new(provider_id: &'static str, tools: Vec<ToolRef<Tool>>) -> Self {
        Self { provider_id, tools }
    }
}

impl<Tool: ?Sized + Send + Sync> StaticToolProvider<Tool> for StaticToolProviderGroup<Tool> {
    fn provider_id(&self) -> &'static str {
        self.provider_id
    }

    fn tools(&self) -> Vec<ToolRef<Tool>> {
        self.tools.clone()
    }
}

pub fn materialize_static_tool_provider_groups<Tool, Plan, Factory>(
    plans: &[Plan],
    factory: &Factory,
) -> Result<Vec<StaticToolProviderGroup<Tool>>, StaticToolMaterializationError>
where
    Tool: ?Sized,
    Plan: StaticToolProviderPlan,
    Factory: StaticToolProviderFactory<Tool> + ?Sized,
{
    let mut providers = Vec::new();
    for plan in plans {
        let provider_id = plan.provider_id();
        let mut tools = Vec::new();
        for tool_name in plan.tool_names() {
            let tool = factory.materialize_tool(tool_name).ok_or(
                StaticToolMaterializationError::UnknownTool {
                    provider_id,
                    tool_name,
                },
            )?;
            tools.push(tool);
        }
        providers.push(StaticToolProviderGroup::new(provider_id, tools));
    }
    Ok(providers)
}

pub struct ToolRuntimeAssembly<Tool: ToolRegistryItem + ?Sized> {
    tool_decorator: ToolDecoratorRef<Tool>,
}

impl<Tool: ToolRegistryItem + ?Sized> Default for ToolRuntimeAssembly<Tool> {
    fn default() -> Self {
        Self::new()
    }
}

impl<Tool: ToolRegistryItem + ?Sized> ToolRuntimeAssembly<Tool> {
    pub fn new() -> Self {
        Self::with_tool_decorator(Arc::new(IdentityToolDecorator))
    }

    pub fn with_tool_decorator(tool_decorator: ToolDecoratorRef<Tool>) -> Self {
        Self { tool_decorator }
    }

    pub fn create_registry_from_static_providers<Provider>(
        &self,
        providers: &[Provider],
    ) -> ToolRegistry<Tool>
    where
        Provider: StaticToolProvider<Tool>,
    {
        let mut registry = ToolRegistry::with_tool_decorator(self.tool_decorator.clone());
        for provider in providers {
            registry.install_static_provider(provider);
        }
        registry
    }

    pub fn create_registry_from_static_provider_plans<Plan, Factory>(
        &self,
        plans: &[Plan],
        factory: &Factory,
    ) -> Result<ToolRegistry<Tool>, StaticToolMaterializationError>
    where
        Plan: StaticToolProviderPlan,
        Factory: StaticToolProviderFactory<Tool> + ?Sized,
    {
        let providers = materialize_static_tool_provider_groups(plans, factory)?;
        Ok(self.create_registry_from_static_providers(&providers))
    }

    pub fn create_registry_from_static_provider_entries<Entries, ToolNames, Factory>(
        &self,
        entries: Entries,
        factory: &Factory,
    ) -> Result<ToolRegistry<Tool>, StaticToolMaterializationError>
    where
        Entries: IntoIterator<Item = (&'static str, ToolNames)>,
        ToolNames: IntoIterator,
        ToolNames::Item: std::borrow::Borrow<&'static str>,
        Factory: StaticToolProviderFactory<Tool> + ?Sized,
    {
        let mut providers = Vec::new();
        for (provider_id, tool_names) in entries {
            let mut tools = Vec::new();
            for tool_name in tool_names {
                let tool_name = *std::borrow::Borrow::borrow(&tool_name);
                let tool = factory.materialize_tool(tool_name).ok_or(
                    StaticToolMaterializationError::UnknownTool {
                        provider_id,
                        tool_name,
                    },
                )?;
                tools.push(tool);
            }
            providers.push(StaticToolProviderGroup::new(provider_id, tools));
        }
        Ok(self.create_registry_from_static_providers(&providers))
    }
}

pub struct ToolRegistry<Tool: ToolRegistryItem + ?Sized> {
    tools: IndexMap<String, ToolRef<Tool>>,
    dynamic_tools: IndexMap<String, DynamicToolMetadata>,
    static_tool_providers: IndexMap<String, String>,
    tool_decorator: ToolDecoratorRef<Tool>,
    snapshot_generation: u64,
}

impl<Tool: ToolRegistryItem + ?Sized> Default for ToolRegistry<Tool> {
    fn default() -> Self {
        Self::new()
    }
}

impl<Tool: ToolRegistryItem + ?Sized> ToolRegistry<Tool> {
    pub fn new() -> Self {
        Self::with_tool_decorator(Arc::new(IdentityToolDecorator))
    }

    pub fn with_tool_decorator(tool_decorator: ToolDecoratorRef<Tool>) -> Self {
        Self {
            tools: IndexMap::new(),
            dynamic_tools: IndexMap::new(),
            static_tool_providers: IndexMap::new(),
            tool_decorator,
            snapshot_generation: 0,
        }
    }

    pub fn register_tool(&mut self, tool: ToolRef<Tool>) {
        self.register_tool_with_static_provider(tool, None);
    }

    fn register_tool_with_static_provider(
        &mut self,
        tool: ToolRef<Tool>,
        static_provider_id: Option<&str>,
    ) {
        let tool = self.tool_decorator.decorate(tool);
        let name = tool.name().to_string();
        let dynamic_info = tool.dynamic_tool_info().and_then(|info| {
            if info.provider_id.trim().is_empty() {
                None
            } else {
                Some(info)
            }
        });

        if let Some(info) = dynamic_info {
            self.dynamic_tools
                .insert(name.clone(), DynamicToolMetadata { info });
            self.static_tool_providers.shift_remove(&name);
        } else {
            self.dynamic_tools.shift_remove(&name);
            match static_provider_id.filter(|provider_id| !provider_id.trim().is_empty()) {
                Some(provider_id) => {
                    self.static_tool_providers
                        .insert(name.clone(), provider_id.to_string());
                }
                None => {
                    self.static_tool_providers.shift_remove(&name);
                }
            }
        }
        self.tools.insert(name, tool);
        self.snapshot_generation = self.snapshot_generation.saturating_add(1);
    }

    pub fn install_static_provider<Provider>(&mut self, provider: &Provider)
    where
        Provider: StaticToolProvider<Tool> + ?Sized,
    {
        let provider_id = provider.provider_id();
        for tool in provider.tools() {
            self.register_tool_with_static_provider(tool, Some(provider_id));
        }
    }

    pub fn unregister_mcp_server_tools(&mut self, server_id: &str) {
        let to_remove = self
            .dynamic_tools
            .iter()
            .filter(|(_, metadata)| {
                metadata
                    .info
                    .mcp
                    .as_ref()
                    .is_some_and(|info| info.server_id == server_id)
            })
            .map(|(tool_name, _)| tool_name.clone())
            .collect::<Vec<_>>();
        let removed_count = to_remove.len();

        for key in to_remove {
            self.tools.shift_remove(&key);
            self.dynamic_tools.shift_remove(&key);
            self.static_tool_providers.shift_remove(&key);
        }
        if removed_count > 0 {
            self.snapshot_generation = self.snapshot_generation.saturating_add(1);
        }
    }

    pub fn unregister_tools_by_prefix(&mut self, prefix: &str) -> usize {
        let to_remove = self
            .tools
            .keys()
            .filter(|key| key.starts_with(prefix))
            .cloned()
            .collect::<Vec<_>>();
        let count = to_remove.len();

        for key in to_remove {
            self.tools.shift_remove(&key);
            self.dynamic_tools.shift_remove(&key);
            self.static_tool_providers.shift_remove(&key);
        }
        if count > 0 {
            self.snapshot_generation = self.snapshot_generation.saturating_add(1);
        }

        count
    }

    /// Remove exactly one registry entry and return the decorated tool that was
    /// active under that name. This is used by contextual compatibility
    /// routers that must preserve, rather than silently discard, a displaced
    /// built-in or dynamic provider.
    pub fn unregister_tool(&mut self, name: &str) -> Option<ToolRef<Tool>> {
        let removed = self.tools.shift_remove(name)?;
        self.dynamic_tools.shift_remove(name);
        self.static_tool_providers.shift_remove(name);
        self.snapshot_generation = self.snapshot_generation.saturating_add(1);
        Some(removed)
    }

    pub fn get_tool(&self, name: &str) -> Option<ToolRef<Tool>> {
        self.tools.get(name).cloned()
    }

    pub fn get_dynamic_tool_info(&self, name: &str) -> Option<DynamicToolInfo> {
        self.dynamic_tools
            .get(name)
            .map(|metadata| metadata.info.clone())
    }

    pub fn is_tool_deferred(&self, name: &str) -> bool {
        self.tools
            .get(name)
            .is_some_and(|tool| tool.default_exposure() == ToolExposure::Deferred)
    }

    pub fn get_deferred_tool_names(&self) -> Vec<String> {
        self.tools
            .iter()
            .filter(|(_, tool)| tool.default_exposure() == ToolExposure::Deferred)
            .map(|(name, _)| name.clone())
            .collect()
    }

    pub fn get_tool_names(&self) -> Vec<String> {
        self.tools.keys().cloned().collect()
    }

    pub fn get_all_tools(&self) -> Vec<ToolRef<Tool>> {
        self.tools.values().cloned().collect()
    }

    pub fn current_snapshot_generation(&self) -> u64 {
        self.snapshot_generation
    }

    pub async fn materialized_tool_snapshot(&self) -> Result<MaterializedToolSnapshot, String> {
        materialize_tool_snapshot(
            &self.get_all_tools(),
            self.snapshot_generation,
            |tool_name| {
                self.static_tool_providers
                    .get(tool_name)
                    .map(|provider_id| ToolProviderIdentity::static_provider(provider_id.clone()))
            },
        )
        .await
    }
}

#[async_trait]
impl<Tool: ToolRegistryItem + ?Sized> DynamicToolProvider for ToolRegistry<Tool> {
    async fn list_dynamic_tools(&self) -> PortResult<Vec<DynamicToolDescriptor>> {
        let dynamic_tools = self
            .tools
            .iter()
            .filter_map(|(name, tool)| self.dynamic_tools.contains_key(name).then(|| tool.clone()))
            .collect::<Vec<_>>();
        let snapshot =
            materialize_tool_snapshot(&dynamic_tools, self.snapshot_generation, |_| None)
                .await
                .map_err(|error| PortError::new(PortErrorKind::Backend, error))?;

        Ok(snapshot
            .dynamic_tools()
            .into_iter()
            .map(|tool| DynamicToolDescriptor {
                name: tool.name.clone(),
                description: tool.description.clone(),
                input_schema: tool.input_schema.clone(),
                provider_id: tool.provider.provider_id.clone(),
            })
            .collect())
    }
}

/// Tool result rendering options.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ToolRenderOptions {
    pub verbose: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolPathBackend {
    Local,
    RemoteWorkspace,
}

#[derive(Debug, Clone)]
pub struct ToolPathResolution {
    pub requested_path: String,
    pub logical_path: String,
    pub resolved_path: String,
    pub backend: ToolPathBackend,
    pub runtime_scope: Option<String>,
    pub runtime_root: Option<PathBuf>,
}

impl ToolPathResolution {
    pub fn uses_remote_workspace_backend(&self) -> bool {
        matches!(self.backend, ToolPathBackend::RemoteWorkspace)
    }

    pub fn is_runtime_artifact(&self) -> bool {
        self.runtime_root.is_some()
    }

    pub fn logical_child_path(&self, absolute_child_path: &Path) -> Option<String> {
        let root = self.runtime_root.as_ref()?;
        let relative = absolute_child_path.strip_prefix(root).ok()?;
        let relative_str = relative.to_string_lossy().replace('\\', "/");
        if is_openbitfun_current_session_uri(&self.logical_path) {
            return build_openbitfun_current_session_uri(&relative_str).ok();
        }
        let scope = self.runtime_scope.as_deref()?;
        build_openbitfun_runtime_uri(scope, &relative_str).ok()
    }
}

pub const OPENBITFUN_RUNTIME_URI_PREFIX: &str = "openbitfun://runtime/";
pub const OPENBITFUN_CURRENT_SESSION_URI_PREFIX: &str = "openbitfun://current-session/";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedOpenBitFunRuntimeUri {
    pub workspace_scope: String,
    pub relative_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedOpenBitFunCurrentSessionUri {
    pub relative_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolPathContractError {
    EmptyRuntimeArtifactPath,
    RuntimeArtifactPathEscapesRoot,
    UnsupportedRuntimeUri { uri: String },
    MissingRuntimeUriWorkspaceScope,
    MissingRuntimeUriArtifactPath,
    EmptyRuntimeWorkspaceScope,
    RuntimeUriScopeMismatch { workspace_scope: String },
    MissingRuntimeRoot,
    MissingCurrentSessionRoot,
    MissingCurrentSessionArtifactPath,
    EmptyPath,
    MissingWorkspaceRoot { path: String },
}

impl fmt::Display for ToolPathContractError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyRuntimeArtifactPath => {
                write!(formatter, "Runtime artifact path cannot be empty")
            }
            Self::RuntimeArtifactPathEscapesRoot => {
                write!(formatter, "Runtime artifact path cannot escape its root")
            }
            Self::UnsupportedRuntimeUri { uri } => {
                write!(formatter, "Unsupported runtime URI: {uri}")
            }
            Self::MissingRuntimeUriWorkspaceScope => {
                write!(formatter, "Runtime URI is missing workspace scope")
            }
            Self::MissingRuntimeUriArtifactPath => {
                write!(formatter, "Runtime URI is missing artifact path")
            }
            Self::EmptyRuntimeWorkspaceScope => {
                write!(formatter, "Runtime URI workspace scope cannot be empty")
            }
            Self::RuntimeUriScopeMismatch { workspace_scope } => {
                write!(
                    formatter,
                    "Runtime URI scope '{workspace_scope}' does not match the current workspace"
                )
            }
            Self::MissingRuntimeRoot => {
                write!(
                    formatter,
                    "A workspace is required to resolve runtime artifacts"
                )
            }
            Self::MissingCurrentSessionRoot => {
                write!(
                    formatter,
                    "A current session is required to resolve session artifacts"
                )
            }
            Self::MissingCurrentSessionArtifactPath => {
                write!(formatter, "Current-session URI is missing artifact path")
            }
            Self::EmptyPath => write!(formatter, "path cannot be empty"),
            Self::MissingWorkspaceRoot { path } => {
                write!(
                    formatter,
                    "A workspace path is required to resolve relative path: {path}"
                )
            }
        }
    }
}

impl std::error::Error for ToolPathContractError {}

pub fn is_openbitfun_runtime_uri(path: &str) -> bool {
    path.trim().starts_with(OPENBITFUN_RUNTIME_URI_PREFIX)
}

pub fn is_openbitfun_current_session_uri(path: &str) -> bool {
    path.trim()
        .starts_with(OPENBITFUN_CURRENT_SESSION_URI_PREFIX)
}

pub fn is_openbitfun_tool_uri(path: &str) -> bool {
    path.trim().starts_with("openbitfun://")
}

pub fn normalize_host_path(path: &str) -> String {
    let path = Path::new(path);
    let mut components = Vec::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                if !components.is_empty() {
                    components.pop();
                }
            }
            component => components.push(component),
        }
    }
    components
        .iter()
        .collect::<PathBuf>()
        .to_string_lossy()
        .to_string()
}

/// Returns a Windows drive path without an invalid POSIX-style leading slash.
/// Non-Windows hosts leave the same spelling available for POSIX path semantics.
pub fn strip_invalid_windows_drive_path_prefix(path: &str) -> Option<&str> {
    #[cfg(windows)]
    {
        let bytes = path.as_bytes();
        if bytes.len() >= 4
            && bytes[0] == b'/'
            && bytes[1].is_ascii_alphabetic()
            && bytes[2] == b':'
            && matches!(bytes[3], b'/' | b'\\')
        {
            return Some(&path[1..]);
        }
    }

    let _ = path;
    None
}

pub fn resolve_host_path_with_workspace(
    path: &str,
    workspace_root: Option<&Path>,
) -> Result<String, ToolPathContractError> {
    let path = strip_invalid_windows_drive_path_prefix(path).unwrap_or(path);

    if Path::new(path).is_absolute() {
        Ok(normalize_host_path(path))
    } else {
        let base_path =
            workspace_root.ok_or_else(|| ToolPathContractError::MissingWorkspaceRoot {
                path: path.to_string(),
            })?;

        Ok(normalize_host_path(
            base_path.join(path).to_string_lossy().as_ref(),
        ))
    }
}

pub fn resolve_host_path(path: &str) -> Result<String, ToolPathContractError> {
    resolve_host_path_with_workspace(path, None)
}

pub fn resolve_workspace_tool_path(
    path: &str,
    workspace_root: Option<&str>,
    workspace_is_remote: bool,
) -> Result<String, ToolPathContractError> {
    if workspace_is_remote {
        posix_resolve_path_with_workspace(path, workspace_root)
    } else {
        resolve_host_path_with_workspace(path, workspace_root.map(Path::new))
    }
}

pub fn resolve_tool_path_with_context(
    path: &str,
    workspace_root: Option<&str>,
    workspace_is_remote: bool,
    workspace_scope: Option<&str>,
    runtime_root: Option<PathBuf>,
) -> Result<ToolPathResolution, ToolPathContractError> {
    resolve_tool_path_with_context_roots(
        path,
        workspace_root,
        workspace_is_remote,
        workspace_scope,
        runtime_root,
        None,
    )
}

pub fn resolve_tool_path_with_context_roots(
    path: &str,
    workspace_root: Option<&str>,
    workspace_is_remote: bool,
    workspace_scope: Option<&str>,
    runtime_root: Option<PathBuf>,
    current_session_root: Option<PathBuf>,
) -> Result<ToolPathResolution, ToolPathContractError> {
    if is_openbitfun_runtime_uri(path) {
        let parsed = parse_openbitfun_runtime_uri(path)?;
        let scope_matches = parsed.workspace_scope == "current"
            || workspace_scope == Some(parsed.workspace_scope.as_str());
        if !scope_matches {
            return Err(ToolPathContractError::RuntimeUriScopeMismatch {
                workspace_scope: parsed.workspace_scope,
            });
        }

        let runtime_root = runtime_root.ok_or(ToolPathContractError::MissingRuntimeRoot)?;
        let mut resolved_path = runtime_root.clone();
        for segment in parsed.relative_path.split('/') {
            resolved_path.push(segment);
        }

        let effective_scope = workspace_scope
            .map(str::to_string)
            .unwrap_or_else(|| parsed.workspace_scope.clone());
        let logical_path = build_openbitfun_runtime_uri(&effective_scope, &parsed.relative_path)?;

        return Ok(ToolPathResolution {
            requested_path: path.to_string(),
            logical_path,
            resolved_path: resolved_path.to_string_lossy().to_string(),
            backend: ToolPathBackend::Local,
            runtime_scope: Some(effective_scope),
            runtime_root: Some(runtime_root),
        });
    }

    if is_openbitfun_current_session_uri(path) {
        let parsed = parse_openbitfun_current_session_uri(path)?;
        let current_session_root =
            current_session_root.ok_or(ToolPathContractError::MissingCurrentSessionRoot)?;
        let mut resolved_path = current_session_root.clone();
        for segment in parsed.relative_path.split('/') {
            resolved_path.push(segment);
        }
        return Ok(ToolPathResolution {
            requested_path: path.to_string(),
            logical_path: build_openbitfun_current_session_uri(&parsed.relative_path)?,
            resolved_path: resolved_path.to_string_lossy().to_string(),
            backend: ToolPathBackend::Local,
            runtime_scope: None,
            runtime_root: Some(current_session_root),
        });
    }

    if is_openbitfun_tool_uri(path) {
        return Err(ToolPathContractError::UnsupportedRuntimeUri {
            uri: path.to_string(),
        });
    }

    let resolved_path = resolve_workspace_tool_path(path, workspace_root, workspace_is_remote)?;
    Ok(ToolPathResolution {
        requested_path: path.to_string(),
        logical_path: resolved_path.clone(),
        resolved_path,
        backend: if workspace_is_remote {
            ToolPathBackend::RemoteWorkspace
        } else {
            ToolPathBackend::Local
        },
        runtime_scope: None,
        runtime_root: None,
    })
}

pub fn tool_path_is_effectively_absolute(path: &str, workspace_is_remote: bool) -> bool {
    if is_openbitfun_tool_uri(path) {
        return true;
    }

    if workspace_is_remote {
        posix_style_path_is_absolute(path)
    } else {
        Path::new(path).is_absolute()
    }
}

pub fn normalize_runtime_relative_path(path: &str) -> Result<String, ToolPathContractError> {
    let normalized = path.trim().replace('\\', "/");
    let trimmed = normalized.trim_matches('/');
    if trimmed.is_empty() {
        return Err(ToolPathContractError::EmptyRuntimeArtifactPath);
    }

    let mut segments = Vec::new();
    for part in trimmed.split('/') {
        match part {
            "" | "." => continue,
            ".." => return Err(ToolPathContractError::RuntimeArtifactPathEscapesRoot),
            value => segments.push(value.to_string()),
        }
    }

    if segments.is_empty() {
        return Err(ToolPathContractError::EmptyRuntimeArtifactPath);
    }

    Ok(segments.join("/"))
}

pub fn parse_openbitfun_runtime_uri(
    path: &str,
) -> Result<ParsedOpenBitFunRuntimeUri, ToolPathContractError> {
    let trimmed = path.trim();
    let suffix = trimmed
        .strip_prefix(OPENBITFUN_RUNTIME_URI_PREFIX)
        .ok_or_else(|| ToolPathContractError::UnsupportedRuntimeUri {
            uri: path.to_string(),
        })?;

    let mut parts = suffix.splitn(2, '/');
    let workspace_scope = parts
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or(ToolPathContractError::MissingRuntimeUriWorkspaceScope)?
        .to_string();
    let relative_path = parts
        .next()
        .ok_or(ToolPathContractError::MissingRuntimeUriArtifactPath)?;

    Ok(ParsedOpenBitFunRuntimeUri {
        workspace_scope,
        relative_path: normalize_runtime_relative_path(relative_path)?,
    })
}

pub fn parse_openbitfun_current_session_uri(
    path: &str,
) -> Result<ParsedOpenBitFunCurrentSessionUri, ToolPathContractError> {
    let trimmed = path.trim();
    let relative_path = trimmed
        .strip_prefix(OPENBITFUN_CURRENT_SESSION_URI_PREFIX)
        .ok_or_else(|| ToolPathContractError::UnsupportedRuntimeUri {
            uri: path.to_string(),
        })?;
    if relative_path.trim().is_empty() {
        return Err(ToolPathContractError::MissingCurrentSessionArtifactPath);
    }
    Ok(ParsedOpenBitFunCurrentSessionUri {
        relative_path: normalize_runtime_relative_path(relative_path)?,
    })
}

pub fn build_openbitfun_current_session_uri(
    relative_path: &str,
) -> Result<String, ToolPathContractError> {
    Ok(format!(
        "{}{}",
        OPENBITFUN_CURRENT_SESSION_URI_PREFIX,
        normalize_runtime_relative_path(relative_path)?
    ))
}

pub fn build_openbitfun_runtime_uri(
    workspace_scope: &str,
    relative_path: &str,
) -> Result<String, ToolPathContractError> {
    let scope = workspace_scope.trim();
    if scope.is_empty() {
        return Err(ToolPathContractError::EmptyRuntimeWorkspaceScope);
    }

    Ok(format!(
        "{}{}/{}",
        OPENBITFUN_RUNTIME_URI_PREFIX,
        scope,
        normalize_runtime_relative_path(relative_path)?
    ))
}

pub fn build_tool_runtime_artifact_reference(
    relative_path: &str,
    runtime_root: Option<&Path>,
    workspace_scope: Option<&str>,
    emit_runtime_uri: bool,
) -> Result<String, ToolPathContractError> {
    let normalized_relative_path = normalize_runtime_relative_path(relative_path)?;
    if emit_runtime_uri {
        return build_openbitfun_runtime_uri(
            workspace_scope.unwrap_or("current"),
            &normalized_relative_path,
        );
    }

    let runtime_root = runtime_root.ok_or(ToolPathContractError::MissingRuntimeRoot)?;
    let mut resolved_path = runtime_root.to_path_buf();
    for segment in normalized_relative_path.split('/') {
        resolved_path.push(segment);
    }

    Ok(resolved_path.to_string_lossy().to_string())
}

pub fn build_tool_session_runtime_artifact_reference(
    session_id: &str,
    relative_path: &str,
    runtime_root: Option<&Path>,
    workspace_scope: Option<&str>,
    emit_runtime_uri: bool,
) -> Result<String, ToolPathContractError> {
    let normalized_relative_path = normalize_runtime_relative_path(relative_path)?;
    build_tool_runtime_artifact_reference(
        &format!("sessions/{}/{}", session_id, normalized_relative_path),
        runtime_root,
        workspace_scope,
        emit_runtime_uri,
    )
}

pub fn posix_style_path_is_absolute(path: &str) -> bool {
    let path = path.trim().replace('\\', "/");
    path.starts_with('/')
}

pub fn normalize_absolute_posix_path(path: &str) -> String {
    let normalized = path.trim().replace('\\', "/");
    let is_absolute = normalized.starts_with('/');
    let mut segments = Vec::new();

    for segment in normalized.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                if !segments.is_empty() {
                    segments.pop();
                }
            }
            value => segments.push(value.to_string()),
        }
    }

    let body = segments.join("/");
    if is_absolute {
        if body.is_empty() {
            "/".to_string()
        } else {
            format!("/{}", body)
        }
    } else {
        body
    }
}

pub fn is_remote_posix_path_within_root(path: &str, root: &str) -> bool {
    let normalized_path = normalize_absolute_posix_path(path);
    let normalized_root = normalize_absolute_posix_path(root);

    if !normalized_path.starts_with('/') || !normalized_root.starts_with('/') {
        return false;
    }

    if normalized_root == "/" {
        return true;
    }

    normalized_path == normalized_root
        || normalized_path
            .strip_prefix(&normalized_root)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

pub fn posix_resolve_path_with_workspace(
    path: &str,
    workspace_root: Option<&str>,
) -> Result<String, ToolPathContractError> {
    let path = path.trim();
    if path.is_empty() {
        return Err(ToolPathContractError::EmptyPath);
    }

    let normalized_input = path.replace('\\', "/");

    let combined = if posix_style_path_is_absolute(&normalized_input) {
        normalized_input
    } else {
        let base = workspace_root
            .ok_or_else(|| ToolPathContractError::MissingWorkspaceRoot {
                path: path.to_string(),
            })?
            .trim()
            .replace('\\', "/");
        let base = base.trim_end_matches('/');
        format!("{}/{}", base, normalized_input)
    };

    Ok(normalize_absolute_posix_path(&combined))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ToolPathOperation {
    Read,
    Write,
    Edit,
    Delete,
}

impl ToolPathOperation {
    pub fn verb(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Write => "write",
            Self::Edit => "edit",
            Self::Delete => "delete",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolPathPolicy {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub read_roots: Vec<String>,
    #[serde(default)]
    pub write_roots: Vec<String>,
    #[serde(default)]
    pub edit_roots: Vec<String>,
    #[serde(default)]
    pub delete_roots: Vec<String>,
}

impl ToolPathPolicy {
    pub fn roots_for(&self, operation: ToolPathOperation) -> &[String] {
        match operation {
            ToolPathOperation::Read => &self.read_roots,
            ToolPathOperation::Write => &self.write_roots,
            ToolPathOperation::Edit => &self.edit_roots,
            ToolPathOperation::Delete => &self.delete_roots,
        }
    }

    pub fn is_restricted(&self, operation: ToolPathOperation) -> bool {
        !self.roots_for(operation).is_empty()
    }
}

pub fn is_tool_path_allowed_by_resolved_roots<E>(
    resolution: &ToolPathResolution,
    resolved_roots: &[ToolPathResolution],
    mut root_contains_path: impl FnMut(&ToolPathResolution, &ToolPathResolution) -> Result<bool, E>,
) -> Result<bool, E> {
    for root in resolved_roots {
        if root.backend != resolution.backend {
            continue;
        }

        if root_contains_path(resolution, root)? {
            return Ok(true);
        }
    }

    Ok(false)
}

pub fn build_tool_path_policy_denial_message(
    logical_path: &str,
    operation: ToolPathOperation,
    allowed_roots: &[String],
) -> String {
    format!(
        "Path '{}' is not allowed for {}. Allowed roots: {}",
        logical_path,
        operation.verb(),
        allowed_roots.join(", ")
    )
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolRuntimeRestrictions {
    #[serde(default)]
    pub allowed_tool_names: BTreeSet<String>,
    #[serde(default)]
    pub denied_tool_names: BTreeSet<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub denied_tool_messages: BTreeMap<String, String>,
    #[serde(default)]
    pub path_policy: ToolPathPolicy,
    /// Host-owned virtual MiniApp context scope for this turn. This grants no
    /// filesystem access by itself; assembled Read/Grep providers resolve it
    /// through the in-process context registry.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub miniapp_context_scope: Option<String>,
}

const MINIAPP_HEADLESS_AGENT_SURFACE: &str = "miniapp_agent";
const MINIAPP_HEADLESS_AGENT_OWNER_PREFIX: &str = "miniapp-agent:";
const MINIAPP_MARKET_STRICT_METADATA_KEY: &str = "marketStrict";
const MINIAPP_CONTEXT_SCOPE_METADATA_KEY: &str = "contextScope";
const MINIAPP_CONTEXT_ROOT: &str = ".miniapp-context";

/// MiniApp agent runs execute inside a MiniApp iframe without Flow Chat tool
/// cards or AskUserQuestion UI. Treat those sessions as headless even on
/// follow-up turns that reuse the hidden session through `created_by`.
pub fn is_miniapp_headless_agent_run(
    user_message_metadata: Option<&serde_json::Value>,
    created_by: Option<&str>,
) -> bool {
    if user_message_metadata
        .and_then(|metadata| metadata.get("surface"))
        .and_then(|value| value.as_str())
        == Some(MINIAPP_HEADLESS_AGENT_SURFACE)
    {
        return true;
    }
    created_by.is_some_and(|owner| owner.starts_with(MINIAPP_HEADLESS_AGENT_OWNER_PREFIX))
}

/// Marketplace MiniApps run under the strict runtime profile, so their agent
/// turns carry `marketStrict` in the submission metadata. Built-in and
/// locally authored MiniApps omit the flag and keep the compatibility tool set.
pub fn is_miniapp_market_strict_agent_run(
    user_message_metadata: Option<&serde_json::Value>,
) -> bool {
    user_message_metadata
        .and_then(|metadata| metadata.get(MINIAPP_MARKET_STRICT_METADATA_KEY))
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

pub fn miniapp_headless_agent_tool_restrictions() -> ToolRuntimeRestrictions {
    const DENIED_TOOLS: &[(&str, &str)] = &[
        (
            "AskUserQuestion",
            "AskUserQuestion is unavailable in MiniApp headless agent runs. Decide yourself and record assumptions in project files.",
        ),
        (
            "ControlHub",
            "ControlHub is unavailable in MiniApp headless agent runs.",
        ),
        (
            "GenerativeUI",
            "GenerativeUI is unavailable in MiniApp headless agent runs.",
        ),
        (
            "ComputerUse",
            "ComputerUse is unavailable in MiniApp headless agent runs.",
        ),
        (
            "ReviewPlatform",
            "ReviewPlatform is unavailable in MiniApp headless agent runs.",
        ),
        (
            "MiniappInit",
            "MiniappInit is unavailable in MiniApp headless agent runs.",
        ),
        (
            "Playbook",
            "Playbook is unavailable in MiniApp headless agent runs.",
        ),
        (
            "Cron",
            "Cron is unavailable in MiniApp headless agent runs.",
        ),
        (
            "ListWorkspaces",
            "ListWorkspaces is unavailable in MiniApp headless agent runs.",
        ),
        (
            "SessionControl",
            "SessionControl is unavailable in MiniApp headless agent runs.",
        ),
    ];

    let mut denied_tool_names = BTreeSet::new();
    let mut denied_tool_messages = BTreeMap::new();
    for (name, message) in DENIED_TOOLS {
        denied_tool_names.insert((*name).to_string());
        denied_tool_messages.insert((*name).to_string(), (*message).to_string());
    }

    ToolRuntimeRestrictions {
        denied_tool_names,
        denied_tool_messages,
        ..Default::default()
    }
}

/// Tool set for a marketplace MiniApp agent turn.
///
/// Marketplace MiniApps are third-party code, so their hidden agent sessions
/// must not reach the general filesystem, the shell, or any host control
/// surface. The host may publish bounded, app-supplied context through a
/// reserved virtual `.miniapp-context/<opaque-scope>` namespace. Read and Grep
/// are added later only when the host supplies a valid scope for this turn, and
/// are confined to that exact immutable snapshot. Read-only web research and the clock
/// remain available for live-world questions. The deferred gateway pair stays
/// allowed because the execution gate matches the effective tool name, so an
/// allowlisted tool that resolves as deferred still has to pass this list. An
/// allowlist (rather than a longer deny list) keeps newly registered tools
/// closed by default.
pub fn miniapp_market_strict_agent_tool_restrictions() -> ToolRuntimeRestrictions {
    const ALLOWED_TOOLS: &[&str] = &[
        "WebSearch",
        "WebFetch",
        "GetToolSpec",
        "CallDeferredTool",
        "GetTime",
    ];

    let mut restrictions = miniapp_headless_agent_tool_restrictions();
    restrictions.allowed_tool_names = ALLOWED_TOOLS
        .iter()
        .map(|name| (*name).to_string())
        .collect();
    restrictions
}

fn miniapp_context_read_root(user_message_metadata: Option<&serde_json::Value>) -> Option<String> {
    let scope = user_message_metadata?
        .get(MINIAPP_CONTEXT_SCOPE_METADATA_KEY)?
        .as_str()?;
    if scope.len() != 32 || !scope.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    Some(format!("{MINIAPP_CONTEXT_ROOT}/{scope}"))
}

/// Restrictions for one agent turn, keyed on whether it belongs to a MiniApp.
///
/// Turns outside the MiniApp agent bridge keep the unrestricted default set.
pub fn miniapp_agent_run_tool_restrictions(
    user_message_metadata: Option<&serde_json::Value>,
    session_created_by: Option<&str>,
) -> ToolRuntimeRestrictions {
    if !is_miniapp_headless_agent_run(user_message_metadata, session_created_by) {
        return ToolRuntimeRestrictions::default();
    }
    if is_miniapp_market_strict_agent_run(user_message_metadata) {
        let mut restrictions = miniapp_market_strict_agent_tool_restrictions();
        if let Some(read_root) = miniapp_context_read_root(user_message_metadata) {
            restrictions.miniapp_context_scope = read_root
                .rsplit_once('/')
                .map(|(_, scope)| scope.to_string());
            restrictions.allowed_tool_names.insert("Read".to_string());
            restrictions.allowed_tool_names.insert("Grep".to_string());
            restrictions.path_policy.read_roots = vec![read_root];
        }
        return restrictions;
    }
    let mut restrictions = miniapp_headless_agent_tool_restrictions();
    restrictions.miniapp_context_scope = miniapp_context_read_root(user_message_metadata)
        .and_then(|root| root.rsplit_once('/').map(|(_, scope)| scope.to_string()));
    restrictions
}

pub fn tool_restrictions_for_delegation_policy(
    delegation_policy: DelegationPolicy,
) -> ToolRuntimeRestrictions {
    let mut restrictions = ToolRuntimeRestrictions::default();
    if !delegation_policy.allow_subagent_spawn {
        for tool_name in ["AgentSpawn"] {
            restrictions.denied_tool_names.insert(tool_name.to_string());
            restrictions.denied_tool_messages.insert(
                tool_name.to_string(),
                "Recursive subagent delegation is blocked. Use direct tools instead.".to_string(),
            );
        }
    }
    restrictions
}

impl ToolRuntimeRestrictions {
    pub fn is_tool_allowed(&self, tool_name: &str) -> bool {
        (self.allowed_tool_names.is_empty() || self.allowed_tool_names.contains(tool_name))
            && !self.denied_tool_names.contains(tool_name)
    }

    pub fn ensure_tool_allowed(&self, tool_name: &str) -> Result<(), ToolRestrictionError> {
        if self.denied_tool_names.contains(tool_name) {
            return Err(ToolRestrictionError::Denied {
                tool_name: tool_name.to_string(),
                message: self.denied_tool_messages.get(tool_name).cloned(),
            });
        }

        if !self.allowed_tool_names.is_empty() && !self.allowed_tool_names.contains(tool_name) {
            return Err(ToolRestrictionError::NotAllowed {
                tool_name: tool_name.to_string(),
            });
        }

        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolRestrictionError {
    Denied {
        tool_name: String,
        message: Option<String>,
    },
    NotAllowed {
        tool_name: String,
    },
}

impl fmt::Display for ToolRestrictionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Denied { tool_name, message } => {
                if let Some(message) = message.as_deref() {
                    write!(formatter, "{message}")
                } else {
                    write!(
                        formatter,
                        "Tool '{}' is denied by runtime restrictions",
                        tool_name
                    )
                }
            }
            Self::NotAllowed { tool_name } => write!(
                formatter,
                "Tool '{}' is not allowed by runtime restrictions",
                tool_name
            ),
        }
    }
}

impl std::error::Error for ToolRestrictionError {}

/// Validation result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidationResult {
    pub result: bool,
    pub message: Option<String>,
    pub error_code: Option<i32>,
    pub meta: Option<Value>,
}

impl ValidationResult {
    /// Whether this rejection represents an invariant that an input rewrite
    /// must not relax. Ordinary schema or formatting failures intentionally
    /// remain repairable by a PreToolUse hook.
    pub fn blocks_input_rewrite(&self) -> bool {
        !self.result
            && self
                .meta
                .as_ref()
                .and_then(|meta| meta.get("blocks_input_rewrite"))
                .and_then(Value::as_bool)
                .unwrap_or(false)
    }
}

impl Default for ValidationResult {
    fn default() -> Self {
        Self {
            result: true,
            message: None,
            error_code: None,
            meta: None,
        }
    }
}

/// Tool execution result
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ToolResult {
    #[serde(rename = "result")]
    Result {
        data: Value,
        #[serde(default)]
        result_for_assistant: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        image_attachments: Option<Vec<ToolImageAttachment>>,
    },
    #[serde(rename = "progress")]
    Progress {
        content: Value,
        normalized_messages: Option<Vec<Value>>,
        tools: Option<Vec<String>>,
    },
    #[serde(rename = "stream_chunk")]
    StreamChunk {
        data: Value,
        chunk_index: usize,
        is_final: bool,
    },
}

impl ToolResult {
    /// Get content (for display)
    pub fn content(&self) -> Value {
        match self {
            ToolResult::Result { data, .. } => data.clone(),
            ToolResult::Progress { content, .. } => content.clone(),
            ToolResult::StreamChunk { data, .. } => data.clone(),
        }
    }

    /// Standard tool success without images.
    pub fn ok(data: Value, result_for_assistant: Option<String>) -> Self {
        Self::Result {
            data,
            result_for_assistant,
            image_attachments: None,
        }
    }

    /// Tool success with optional images for multimodal tool results (Anthropic).
    pub fn ok_with_images(
        data: Value,
        result_for_assistant: Option<String>,
        image_attachments: Vec<ToolImageAttachment>,
    ) -> Self {
        Self::Result {
            data,
            result_for_assistant,
            image_attachments: Some(image_attachments),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validation_result_only_blocks_rewrites_when_explicitly_marked() {
        let repairable = ValidationResult {
            result: false,
            message: Some("repairable".to_string()),
            error_code: Some(400),
            meta: None,
        };
        let non_relaxable = ValidationResult {
            result: false,
            message: Some("protected".to_string()),
            error_code: Some(403),
            meta: Some(json!({ "blocks_input_rewrite": true })),
        };

        assert!(!repairable.blocks_input_rewrite());
        assert!(non_relaxable.blocks_input_rewrite());
        assert!(!ValidationResult::default().blocks_input_rewrite());
    }

    struct TestTool {
        name: &'static str,
        available: bool,
    }

    #[async_trait]
    impl ToolRegistryItem for TestTool {
        fn name(&self) -> &str {
            self.name
        }

        async fn description(&self) -> Result<String, String> {
            Ok(format!("{} description", self.name))
        }

        fn input_schema(&self) -> Value {
            json!({
                "type": "object",
                "properties": {},
            })
        }
    }

    #[async_trait]
    impl ContextualToolManifestItem<()> for TestTool {
        async fn is_available_in_context(&self, _context: &()) -> bool {
            self.available
        }
    }

    #[tokio::test]
    async fn contextual_manifest_omits_unavailable_tools_from_model_definitions() {
        let task = Arc::new(TestTool {
            name: "AgentSpawn",
            available: false,
        });
        let read = Arc::new(TestTool {
            name: "Read",
            available: true,
        });
        let tools: Vec<Arc<TestTool>> = vec![task, read];
        let allowed_tools = vec!["AgentSpawn".to_string(), "Read".to_string()];

        let manifest = resolve_contextual_tool_manifest(
            &tools,
            &allowed_tools,
            &IndexMap::new(),
            &(),
            GET_TOOL_SPEC_TOOL_NAME,
        )
        .await;

        assert!(!manifest
            .tool_definitions
            .iter()
            .any(|definition| definition.name == "AgentSpawn"));
        assert!(manifest
            .tool_definitions
            .iter()
            .any(|definition| definition.name == "Read"));
    }

    #[test]
    fn get_tool_spec_description_preserves_prompt_contract() {
        let description = build_get_tool_spec_description();

        assert!(description.contains("Read the full schema"));
        assert!(description.contains("Do not call GetToolSpec again"));
        assert!(description.contains("full definition is still visible in the current context"));
        assert!(description
            .contains("If compaction or truncation removed that result, call GetToolSpec again"));
        assert!(description.contains("does not load its definition"));
    }

    #[test]
    fn get_tool_spec_catalog_description_keeps_builtin_summaries_optional() {
        let description = build_get_tool_spec_catalog_description(&[
            GetToolSpecDeferredToolSummary {
                name: "Worktree".to_string(),
                short_description: Some("Inspect repository state.".to_string()),
            },
            GetToolSpecDeferredToolSummary {
                name: "WebFetch".to_string(),
                short_description: None,
            },
        ])
        .expect("catalog description");

        assert!(description.contains("- Worktree"));
        assert!(description.contains("- WebFetch"));
        assert!(description.contains("- Worktree: Inspect repository state."));
        assert!(!description.contains("Fetch a URL."));
    }

    #[test]
    fn delegation_policy_tool_restrictions_block_recursive_subagents() {
        let restrictions =
            tool_restrictions_for_delegation_policy(DelegationPolicy::top_level().spawn_child());

        assert!(!restrictions.is_tool_allowed("AgentSpawn"));
        assert!(restrictions.is_tool_allowed("Read"));
        assert_eq!(
            restrictions
                .ensure_tool_allowed("AgentSpawn")
                .expect_err("AgentSpawn should be blocked")
                .to_string(),
            "Recursive subagent delegation is blocked. Use direct tools instead."
        );
    }

    #[test]
    fn miniapp_headless_tool_restrictions_block_interactive_tools() {
        let restrictions = miniapp_headless_agent_tool_restrictions();

        assert!(!restrictions.is_tool_allowed("AskUserQuestion"));
        assert!(!restrictions.is_tool_allowed("ControlHub"));
        assert!(!restrictions.is_tool_allowed("Cron"));
        assert!(restrictions.is_tool_allowed("AgentSpawn"));
        assert!(restrictions.is_tool_allowed("WebSearch"));
    }

    #[test]
    fn miniapp_headless_run_detection_uses_surface_and_created_by() {
        let metadata = json!({ "surface": "miniapp_agent" });

        assert!(is_miniapp_headless_agent_run(Some(&metadata), None));
        assert!(is_miniapp_headless_agent_run(
            None,
            Some("miniapp-agent:builtin-ppt-live:run-1")
        ));
        assert!(!is_miniapp_headless_agent_run(None, Some("desktop-user")));
    }

    #[test]
    fn runtime_restrictions_allow_all_when_empty() {
        let restrictions = ToolRuntimeRestrictions::default();

        assert!(restrictions.is_tool_allowed("Write"));
        assert!(restrictions.ensure_tool_allowed("Write").is_ok());
    }

    #[test]
    fn denied_tool_names_override_allow_list() {
        let restrictions = ToolRuntimeRestrictions {
            allowed_tool_names: ["Write", "Edit"].into_iter().map(str::to_string).collect(),
            denied_tool_names: ["Write"].into_iter().map(str::to_string).collect(),
            denied_tool_messages: Default::default(),
            path_policy: ToolPathPolicy::default(),
            miniapp_context_scope: None,
        };

        assert!(!restrictions.is_tool_allowed("Write"));
        assert!(restrictions.is_tool_allowed("Edit"));
    }

    #[test]
    fn custom_deny_message_overrides_generic_runtime_error() {
        let restrictions = ToolRuntimeRestrictions {
            denied_tool_names: ["AgentSpawn"].into_iter().map(str::to_string).collect(),
            denied_tool_messages: [(
                "AgentSpawn".to_string(),
                "Recursive subagent delegation is blocked. Use direct tools instead.".to_string(),
            )]
            .into_iter()
            .collect(),
            ..Default::default()
        };

        let error = restrictions
            .ensure_tool_allowed("AgentSpawn")
            .expect_err("custom deny message should be used");
        assert_eq!(
            error.to_string(),
            "Recursive subagent delegation is blocked. Use direct tools instead."
        );
    }

    #[test]
    fn remote_posix_roots_require_true_containment() {
        assert!(is_remote_posix_path_within_root(
            "/workspace/src/lib.rs",
            "/workspace/src"
        ));
        assert!(!is_remote_posix_path_within_root(
            "/workspace/src2/lib.rs",
            "/workspace/src"
        ));
    }

    #[test]
    fn generic_tool_runtime_assembly_materializes_provider_entries_without_adapter() {
        struct EntryFactory;
        impl StaticToolProviderFactory<TestTool> for EntryFactory {
            fn materialize_tool(&self, tool_name: &str) -> Option<ToolRef<TestTool>> {
                Some(Arc::new(TestTool {
                    name: match tool_name {
                        "Read" => "Read",
                        "Write" => "Write",
                        _ => return None,
                    },
                    available: true,
                }))
            }
        }

        let assembly = ToolRuntimeAssembly::<TestTool>::new();
        let registry = assembly
            .create_registry_from_static_provider_entries(
                [("core.basic", &["Read", "Write"][..])],
                &EntryFactory,
            )
            .expect("provider entries should materialize");

        assert_eq!(registry.get_tool_names(), vec!["Read", "Write"]);
    }

    #[test]
    fn market_strict_miniapp_runs_default_to_web_only_and_drop_host_reach() {
        let restrictions = miniapp_market_strict_agent_tool_restrictions();

        assert!(!restrictions.is_tool_allowed("Read"));
        assert!(!restrictions.is_tool_allowed("Grep"));
        assert!(restrictions.is_tool_allowed("WebSearch"));
        assert!(restrictions.is_tool_allowed("WebFetch"));
        assert!(restrictions.is_tool_allowed("GetToolSpec"));
        assert!(restrictions.path_policy.read_roots.is_empty());

        for denied in ["Write", "Edit", "ExecCommand", "AgentSpawn", "Skill"] {
            assert!(
                !restrictions.is_tool_allowed(denied),
                "{denied} must stay closed for marketplace MiniApp agent runs"
            );
        }

        // The headless denials still apply on top of the allowlist.
        assert!(!restrictions.is_tool_allowed("AskUserQuestion"));
        assert!(matches!(
            restrictions.ensure_tool_allowed("ComputerUse"),
            Err(ToolRestrictionError::Denied { .. })
        ));
        assert!(matches!(
            restrictions.ensure_tool_allowed("Write"),
            Err(ToolRestrictionError::NotAllowed { .. })
        ));
    }

    #[test]
    fn builtin_miniapp_runs_keep_the_compatibility_tool_set() {
        let restrictions = miniapp_headless_agent_tool_restrictions();

        assert!(restrictions.is_tool_allowed("WebSearch"));
        assert!(restrictions.is_tool_allowed("WebFetch"));
        assert!(restrictions.is_tool_allowed("Write"));
        assert!(!restrictions.is_tool_allowed("AskUserQuestion"));
    }

    #[test]
    fn market_strict_detection_reads_the_turn_metadata_flag() {
        assert!(is_miniapp_market_strict_agent_run(Some(&json!({
            "surface": "miniapp_agent",
            "marketStrict": true,
        }))));
        assert!(!is_miniapp_market_strict_agent_run(Some(&json!({
            "surface": "miniapp_agent",
        }))));
        assert!(!is_miniapp_market_strict_agent_run(None));
    }

    #[test]
    fn miniapp_run_restrictions_follow_the_runtime_profile_of_the_turn() {
        let created_by = Some("miniapp-agent:app-1:run-1");
        let market_strict = json!({
            "surface": "miniapp_agent",
            "marketStrict": true,
        });
        let market_with_context = json!({
            "surface": "miniapp_agent",
            "marketStrict": true,
            "contextScope": "0123456789abcdef0123456789abcdef",
        });
        let builtin = json!({ "surface": "miniapp_agent" });

        let strict = miniapp_agent_run_tool_restrictions(Some(&market_strict), created_by);
        assert!(!strict.is_tool_allowed("Write"));
        assert!(!strict.is_tool_allowed("Read"));

        let scoped = miniapp_agent_run_tool_restrictions(Some(&market_with_context), created_by);
        assert!(scoped.is_tool_allowed("Read"));
        assert!(scoped.is_tool_allowed("Grep"));
        // Adding app context must never narrow a research Agent into a
        // closed-book file reader, including deferred tool exposure.
        for tool in [
            "WebSearch",
            "WebFetch",
            "GetTime",
            "GetToolSpec",
            "CallDeferredTool",
        ] {
            assert!(scoped.is_tool_allowed(tool), "context must retain {tool}");
        }
        for tool in ["Write", "Edit", "ExecCommand", "AgentSpawn"] {
            assert!(!scoped.is_tool_allowed(tool));
        }
        assert_eq!(
            scoped.path_policy.read_roots,
            vec![".miniapp-context/0123456789abcdef0123456789abcdef"]
        );
        assert_eq!(
            scoped.miniapp_context_scope.as_deref(),
            Some("0123456789abcdef0123456789abcdef")
        );
        assert!(
            miniapp_agent_run_tool_restrictions(Some(&builtin), created_by)
                .is_tool_allowed("Write")
        );
        let builtin_with_context = json!({
            "surface": "miniapp_agent",
            "contextScope": "fedcba9876543210fedcba9876543210",
        });
        let builtin_scoped =
            miniapp_agent_run_tool_restrictions(Some(&builtin_with_context), created_by);
        assert!(builtin_scoped.path_policy.read_roots.is_empty());
        assert_eq!(
            builtin_scoped.miniapp_context_scope.as_deref(),
            Some("fedcba9876543210fedcba9876543210")
        );

        let invalid_scope = json!({
            "surface": "miniapp_agent",
            "marketStrict": true,
            "contextScope": "../outside",
        });
        assert!(
            !miniapp_agent_run_tool_restrictions(Some(&invalid_scope), created_by)
                .is_tool_allowed("Read")
        );
        // A turn outside the MiniApp bridge keeps the unrestricted default set,
        // even when some other surface happens to carry the strict flag.
        let other_surface = json!({ "surface": "chat", "marketStrict": true });
        assert!(
            miniapp_agent_run_tool_restrictions(Some(&other_surface), None)
                .is_tool_allowed("Write")
        );
    }
}
