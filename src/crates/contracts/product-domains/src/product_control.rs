//! Platform-agnostic contracts and discovery policy for controlling OpenBitFun itself.
//!
//! The resolved graph is generated from owner facts plus the same explanatory
//! overlay used by the Playbook and global search. Concrete providers live in
//! product hosts; this module owns stable DTOs, lookup/search behavior, and
//! input-shape validation. It deliberately does not expose an arbitrary config
//! path or Tauri-command gateway.

use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

const GENERATED_CATALOG: &str = include_str!("generated/product-control-catalog.json");
pub const MAX_DISCOVERY_LIMIT: usize = 50;

/// The caller is audit metadata. Owner behavior must never branch on this
/// value; all surfaces reach the same query/command handler after their own
/// permission and presentation adaptation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ProductControlSource {
    Gui,
    Agent,
    Cli,
    Peer,
    RemoteControl,
    DetachedDispatch,
    #[default]
    Compatibility,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProductControlDeliveryProfile {
    Desktop,
    Cli,
    Peer,
    RemoteControl,
    DetachedDispatch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProductControlExecutionHost {
    ProductHost,
    WorkspaceHost,
    PresentationSurface,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProductControlAction {
    List,
    Search,
    Get,
    Open,
    Execute,
    Configure,
}

impl ProductControlAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::List => "list",
            Self::Search => "search",
            Self::Get => "get",
            Self::Open => "open",
            Self::Execute => "execute",
            Self::Configure => "configure",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductControlRequest {
    pub action: ProductControlAction,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capability_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub option_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arguments: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
    #[serde(default)]
    pub source: ProductControlSource,
}

pub type ProductControlFuture<'a> =
    Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'a>>;

/// Host adapter for state inspection, mutations, and product-surface routing.
pub trait ProductControlPort: Send + Sync {
    fn invoke<'a>(&'a self, request: ProductControlRequest) -> ProductControlFuture<'a>;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductControlCatalog {
    pub schema_version: u32,
    pub product: String,
    pub title: String,
    pub origin: String,
    pub source: String,
    pub digest: String,
    pub owner_digest: String,
    pub search_acceptance: Vec<ProductControlSearchAcceptance>,
    pub counts: ProductControlCounts,
    pub categories: BTreeMap<String, ProductControlCategory>,
    pub capabilities: Vec<ProductCapability>,
    #[serde(default)]
    pub definitions: Vec<ProductControlDefinition>,
}

/// The build-resolved graph consumed by Rust, TypeScript, search and docs.
/// `ProductControlCatalog` remains as a compatibility name for existing
/// consumers while new code uses the architecture term.
pub type ResolvedProductCapabilityGraph = ProductControlCatalog;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProductControlDefinitionKind {
    Query,
    Option,
    Operation,
    Delegate,
    Open,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductControlDefinition {
    pub id: String,
    pub capability_id: String,
    pub item_ids: Vec<String>,
    pub kind: ProductControlDefinitionKind,
    pub risk: ProductControlRisk,
    pub execution_host: ProductControlExecutionHost,
    pub availability: BTreeMap<ProductControlDeliveryProfile, ProductControlAvailability>,
    pub input_schema: Value,
    pub output_schema: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value_source: Option<ProductControlValueSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_reason: Option<ProductControlOpenReason>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub delegate_tools: Vec<String>,
    pub presentation_target: ProductCapabilityDestination,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ProductControlValueSource {
    Static,
    AppearanceCatalog,
    LocaleCatalog,
    Provider { provider_id: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductControlAvailability {
    pub available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Runtime capabilities that must be negotiated with the executing host.
    /// Static graph availability never overrides cross-version negotiation.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub required_capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductControlQueryRequest {
    pub capability_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub option_id: Option<String>,
    #[serde(default)]
    pub source: ProductControlSource,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductControlQueryResult {
    pub catalog_digest: String,
    pub capability_id: String,
    pub revision: u64,
    pub current_option_values: BTreeMap<String, Value>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub dynamic_values: BTreeMap<String, Vec<Value>>,
    pub availability: ProductControlAvailability,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ProductControlCommand {
    Configure {
        option_id: String,
        value: Value,
    },
    Execute {
        operation_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        arguments: Option<Value>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductControlExecuteRequest {
    pub capability_id: String,
    pub command: ProductControlCommand,
    #[serde(default)]
    pub source: ProductControlSource,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductControlOutcome {
    pub catalog_digest: String,
    pub capability_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub option_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    pub revision: u64,
    pub effective_state: Value,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub changed_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductControlSearchAcceptance {
    pub id: String,
    pub query: String,
    pub expected_first_capability_id: String,
    pub expected_capability_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_item: Option<ProductControlSearchAcceptanceItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductControlSearchAcceptanceItem {
    pub capability_id: String,
    pub item_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductControlCounts {
    pub features: usize,
    pub settings: usize,
    pub user_facing: usize,
    pub documented_items: usize,
    pub control_coverage: ProductControlCoverage,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductControlCoverage {
    pub direct: usize,
    pub delegated: usize,
    pub interactive: usize,
    pub unsupported: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductControlCategory {
    pub title_zh: String,
    pub title_en: String,
    pub description_zh: String,
    pub description_en: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProductCapabilityKind {
    Feature,
    Setting,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductCapability {
    pub id: String,
    pub kind: ProductCapabilityKind,
    pub category_id: String,
    pub title_zh: String,
    pub title_en: String,
    pub summary_zh: String,
    pub summary_en: String,
    pub keywords_zh: Vec<String>,
    pub keywords_en: Vec<String>,
    pub highlights_zh: Vec<String>,
    pub highlights_en: Vec<String>,
    pub items: Vec<ProductCapabilityItem>,
    pub steps_zh: Vec<String>,
    pub steps_en: Vec<String>,
    pub agent_examples_zh: Vec<String>,
    pub agent_examples_en: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_control: Option<ProductCapabilityAgentControl>,
    pub destination: ProductCapabilityDestination,
    #[serde(default)]
    pub operations: Vec<ProductCapabilityOperation>,
    #[serde(default)]
    pub options: Vec<ProductCapabilityOption>,
    #[serde(default)]
    pub search_terms: Vec<String>,
    pub docs_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductCapabilityItem {
    pub id: String,
    pub title_zh: String,
    pub title_en: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destination: Option<ProductCapabilityDestination>,
    pub control: ProductCapabilityItemControl,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum ProductCapabilityItemControl {
    Direct {
        operations: Vec<String>,
        options: Vec<ProductCapabilityDirectOption>,
    },
    Delegate {
        tools: Vec<String>,
        workflow_zh: Vec<String>,
        workflow_en: Vec<String>,
    },
    Open {
        #[serde(default)]
        reason_code: ProductControlOpenReason,
        reason_zh: String,
        reason_en: String,
    },
    Unsupported {
        reason_zh: String,
        reason_en: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProductControlOpenReason {
    ExternalAuth,
    SecretEntry,
    VisualSelection,
    UnstructuredInteraction,
}

impl Default for ProductControlOpenReason {
    fn default() -> Self {
        Self::UnstructuredInteraction
    }
}

impl ProductCapabilityItemControl {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Direct { .. } => "direct",
            Self::Delegate { .. } => "delegate",
            Self::Open { .. } => "open",
            Self::Unsupported { .. } => "unsupported",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductCapabilityDirectOption {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductCapabilityAgentControl {
    pub tool: String,
    pub workflow_zh: Vec<String>,
    pub workflow_en: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ProductCapabilityDestination {
    Settings {
        page_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        view_id: Option<String>,
    },
    Action {
        action_id: String,
    },
    Scene {
        scene_id: String,
    },
    Event {
        event_name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        detail: Option<Map<String, Value>>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProductControlRisk {
    Read,
    Write,
    Ui,
    Execute,
    Destructive,
}

/// Where an operation argument is resolved. Product-host-local paths are
/// intentionally explicit so a remote workspace cannot silently reinterpret a
/// remote POSIX path as a path on the controller/Desktop host.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProductControlArgumentScope {
    ProductHostLocal,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductCapabilityOperation {
    pub id: String,
    pub title_zh: String,
    pub title_en: String,
    pub description_zh: String,
    pub description_en: String,
    pub risk: ProductControlRisk,
    pub input_schema: Value,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub argument_scopes: BTreeMap<String, ProductControlArgumentScope>,
    pub handler: ProductCapabilityOperationHandler,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ProductCapabilityOperationHandler {
    ProductAction {
        action_id: String,
    },
    Provider {
        provider_id: String,
        operation_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductCapabilityOption {
    pub id: String,
    pub title_zh: String,
    pub title_en: String,
    pub description_zh: String,
    pub description_en: String,
    pub value_schema: ProductControlValueSchema,
    pub handler: ProductCapabilityOptionHandler,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductControlValueSchema {
    #[serde(rename = "type")]
    pub value_type: ProductControlValueType,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub nullable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#enum: Option<Vec<Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minimum: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub maximum: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_length: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_length: Option<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProductControlValueType {
    Boolean,
    String,
    Integer,
    Number,
    Object,
    Array,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ProductCapabilityOptionHandler {
    Config {
        path: String,
    },
    MergeConfig {
        path: String,
        fields: Vec<String>,
    },
    AppearanceSelection,
    Language,
    FlowChatPermissionModeControl,
    Provider {
        provider_id: String,
        option_id: String,
    },
}

static CATALOG: OnceLock<Result<ProductControlCatalog, String>> = OnceLock::new();
static REGISTRY: ProductControlRegistry = ProductControlRegistry;

/// Read-only router over the build-resolved product capability graph.
///
/// The registry owns no product state and executes no IO. Business hosts bind
/// the typed handlers embedded in the internal graph to their concrete ports;
/// discovery, GUI, Agent, CLI, search, and Playbook all resolve stable IDs here.
#[derive(Debug)]
pub struct ProductControlRegistry;

impl ProductControlRegistry {
    pub fn global() -> &'static Self {
        &REGISTRY
    }

    pub fn graph(&self) -> Result<&'static ResolvedProductCapabilityGraph, String> {
        CATALOG
            .get_or_init(|| {
                serde_json::from_str(GENERATED_CATALOG).map_err(|error| {
                    format!("Generated product-control catalog is invalid: {error}")
                })
            })
            .as_ref()
            .map_err(Clone::clone)
    }

    pub fn capability(&self, capability_id: &str) -> Result<&'static ProductCapability, String> {
        self.graph()?
            .capabilities
            .iter()
            .find(|capability| capability.id == capability_id)
            .ok_or_else(|| format!("Unknown OpenBitFun capability: {capability_id}"))
    }

    pub fn definition(
        &self,
        definition_id: &str,
    ) -> Result<&'static ProductControlDefinition, String> {
        self.graph()?
            .definitions
            .iter()
            .find(|definition| definition.id == definition_id)
            .ok_or_else(|| {
                format!("Unknown OpenBitFun product-control definition: {definition_id}")
            })
    }

    pub fn option(
        &self,
        capability_id: &str,
        option_id: &str,
    ) -> Result<&'static ProductCapabilityOption, String> {
        self.capability(capability_id)?
            .options
            .iter()
            .find(|option| option.id == option_id)
            .ok_or_else(|| format!("Unknown option for {capability_id}: {option_id}"))
    }

    pub fn operation(
        &self,
        capability_id: &str,
        operation_id: &str,
    ) -> Result<&'static ProductCapabilityOperation, String> {
        self.capability(capability_id)?
            .operations
            .iter()
            .find(|operation| operation.id == operation_id)
            .ok_or_else(|| format!("Unknown operation for {capability_id}: {operation_id}"))
    }
}

pub fn catalog() -> Result<&'static ProductControlCatalog, String> {
    ProductControlRegistry::global().graph()
}

pub fn capability(capability_id: &str) -> Result<&'static ProductCapability, String> {
    ProductControlRegistry::global().capability(capability_id)
}

/// Validate a presentation target against the same semantic catalog used for
/// discovery. Hosts call this before crossing a UI/event boundary so a stale
/// or fabricated item id fails immediately instead of timing out in a surface.
pub fn validate_open_target(
    capability_id: &str,
    item_id: Option<&str>,
) -> Result<&'static ProductCapability, String> {
    let capability = capability(capability_id)?;
    if let Some(item_id) = item_id.map(str::trim).filter(|item_id| !item_id.is_empty()) {
        if !capability.items.iter().any(|item| item.id == item_id) {
            return Err(format!(
                "Unknown documented item for {capability_id}: {item_id}"
            ));
        }
    }
    Ok(capability)
}

fn split_terms(value: &str) -> Vec<String> {
    value
        .split(|character: char| {
            character.is_whitespace() || matches!(character, '.' | '_' | '/' | '\\' | ':' | '-')
        })
        .map(str::trim)
        .filter(|term| {
            term.chars().count() >= 2
                || term
                    .chars()
                    .any(|character| ('\u{3400}'..='\u{9fff}').contains(&character))
        })
        .map(str::to_lowercase)
        .collect()
}

fn score_single_term(query: &str, field: &str) -> u32 {
    if field == query {
        return 100;
    }
    if field.starts_with(query) {
        return 94;
    }
    let words = split_terms(field);
    if words.iter().any(|word| word.starts_with(query)) {
        return 88;
    }
    if field.contains(query) {
        return 80;
    }
    let acronym: String = words
        .iter()
        .filter_map(|word| word.chars().next())
        .collect();
    // Initials must be consecutive. Skipping arbitrary words makes long
    // workflow prose spuriously match unrelated queries such as "pet".
    if query.chars().count() > 1 && acronym.contains(query) {
        return 66;
    }
    0
}

pub fn score_text_match(query: &str, fields: &[&str]) -> u32 {
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return 70;
    }
    let normalized_fields: Vec<String> = fields
        .iter()
        .map(|field| field.trim().to_lowercase())
        .filter(|field| !field.is_empty())
        .collect();
    let mut best = normalized_fields
        .iter()
        .map(|field| score_single_term(&query, field))
        .max()
        .unwrap_or_default();
    let terms = split_terms(&query);
    if terms.len() > 1 {
        let scores: Vec<u32> = terms
            .iter()
            .map(|term| {
                normalized_fields
                    .iter()
                    .map(|field| score_single_term(term, field))
                    .max()
                    .unwrap_or_default()
            })
            .collect();
        if scores.iter().all(|score| *score > 0) {
            best = best.max(72);
        }
        let matched: Vec<u32> = scores.into_iter().filter(|score| *score > 0).collect();
        if !matched.is_empty() {
            let coverage = matched.len() as f64 / terms.len() as f64;
            let strongest = matched.iter().copied().max().unwrap_or_default() as f64;
            best = best.max((38.0 + coverage * 28.0 + strongest * 0.08).round() as u32);
        }
    }
    best
}

fn public_capability_value(capability: &ProductCapability) -> Result<Value, String> {
    let mut value = serde_json::to_value(capability).map_err(|error| error.to_string())?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| "Product capability did not serialize to an object".to_string())?;
    for collection in ["operations", "options"] {
        for entry in object
            .get_mut(collection)
            .and_then(Value::as_array_mut)
            .into_iter()
            .flatten()
        {
            if let Some(entry) = entry.as_object_mut() {
                entry.remove("handler");
            }
        }
    }
    Ok(value)
}

fn compact_capability(capability: &ProductCapability, query: &str) -> Value {
    let mut matched_items: Vec<(&ProductCapabilityItem, u32)> = if query.is_empty() {
        Vec::new()
    } else {
        capability
            .items
            .iter()
            .filter_map(|item| {
                let score = score_text_match(query, &[&item.title_zh, &item.title_en]);
                (score > 0).then_some((item, score))
            })
            .collect()
    };
    matched_items.sort_by(|left, right| right.1.cmp(&left.1));
    let matched_items: Vec<Value> = matched_items
        .into_iter()
        .take(5)
        .map(|(item, _)| {
            json!({
                // Keep `id` for compatibility with existing discovery consumers,
                // while exposing the unambiguous control-route field names used
                // by ProductControlRequest.
                "id": item.id,
                "capabilityId": capability.id,
                "itemId": item.id,
                "titleZh": item.title_zh,
                "titleEn": item.title_en,
                "destination": item.destination,
                "control": item.control,
            })
        })
        .collect();
    let item_control_count = |kind: &str| {
        capability
            .items
            .iter()
            .filter(|item| item.control.kind() == kind)
            .count()
    };
    json!({
        // `id` remains a compatibility alias. New Agent and API consumers use
        // `capabilityId`, which cannot be confused with a matched item's id.
        "id": capability.id,
        "capabilityId": capability.id,
        "kind": capability.kind,
        "titleZh": capability.title_zh,
        "titleEn": capability.title_en,
        "summaryZh": capability.summary_zh,
        "summaryEn": capability.summary_en,
        "categoryId": capability.category_id,
        "operationCount": capability.operations.len(),
        "configurableOptionCount": capability.options.len(),
        "documentedItemCount": capability.items.len(),
        "controlCoverage": {
            "direct": item_control_count("direct"),
            "delegated": item_control_count("delegate"),
            "interactive": item_control_count("open"),
        },
        "matchedItems": matched_items,
        "nextAction": {
            "action": "get",
            "capabilityId": capability.id,
        },
        "nextToolCall": {
            "action": "get",
            "capability_id": capability.id,
        },
    })
}

fn control_priority(capability: &ProductCapability) -> u32 {
    let direct = (capability.operations.len() + capability.options.len()).min(8) as u32;
    let delegated = capability
        .items
        .iter()
        .any(|item| matches!(&item.control, ProductCapabilityItemControl::Delegate { .. }))
        .then_some(4)
        .unwrap_or_default();
    direct + delegated
}

pub fn discover(request: &ProductControlRequest) -> Result<Value, String> {
    let catalog = catalog()?;
    let query = request.query.as_deref().unwrap_or_default().trim();
    if request.action == ProductControlAction::Search && query.is_empty() {
        return Err("query is required for search".to_string());
    }
    let cursor = request.cursor.unwrap_or_default();
    let default_limit = if request.action == ProductControlAction::List {
        MAX_DISCOVERY_LIMIT
    } else {
        20
    };
    let limit = request
        .limit
        .unwrap_or(default_limit)
        .clamp(1, MAX_DISCOVERY_LIMIT);
    let mut matches: Vec<(&ProductCapability, u32)> = catalog
        .capabilities
        .iter()
        .filter_map(|capability| {
            let text_score = if request.action == ProductControlAction::Search {
                let mut fields = vec![
                    capability.id.as_str(),
                    capability.title_zh.as_str(),
                    capability.title_en.as_str(),
                ];
                fields.extend(capability.search_terms.iter().map(String::as_str));
                score_text_match(query, &fields)
            } else {
                1
            };
            // Control coverage is a tie-breaker only after a textual match.
            // Adding it first makes unrelated but highly controllable entries
            // appear for every search query.
            (text_score > 0).then_some((capability, text_score))
        })
        .collect();
    matches.sort_by(|left, right| {
        right
            .1
            .cmp(&left.1)
            .then_with(|| {
                let left_controls = control_priority(left.0);
                let right_controls = control_priority(right.0);
                right_controls.cmp(&left_controls)
            })
            .then_with(|| left.0.id.cmp(&right.0.id))
    });
    let total_count = matches.len();
    let items: Vec<Value> = matches
        .into_iter()
        .skip(cursor)
        .take(limit)
        .map(|(capability, _)| compact_capability(capability, query))
        .collect();
    let next_cursor = (cursor + items.len() < total_count).then_some(cursor + items.len());
    Ok(json!({
        "catalogDigest": catalog.digest,
        "counts": catalog.counts,
        "totalCount": total_count,
        "cursor": cursor,
        "nextCursor": next_cursor,
        "items": items,
    }))
}

pub fn inspect_contract(capability_id: &str) -> Result<Value, String> {
    let catalog = catalog()?;
    let capability = capability(capability_id)?;
    Ok(json!({
        "catalogDigest": catalog.digest,
        "capability": public_capability_value(capability)?,
    }))
}

pub fn validate_option_value(
    schema: &ProductControlValueSchema,
    value: &Value,
) -> Result<(), String> {
    if value.is_null() {
        return if schema.nullable {
            Ok(())
        } else {
            Err("value must not be null".to_string())
        };
    }
    let type_matches = match schema.value_type {
        ProductControlValueType::Boolean => value.is_boolean(),
        ProductControlValueType::String => value.is_string(),
        ProductControlValueType::Integer => value.as_i64().is_some() || value.as_u64().is_some(),
        ProductControlValueType::Number => value.is_number(),
        ProductControlValueType::Object => value.is_object(),
        ProductControlValueType::Array => value.is_array(),
    };
    if !type_matches {
        return Err(format!("value must match type {:?}", schema.value_type).to_lowercase());
    }
    if let Some(candidates) = &schema.r#enum {
        if !candidates.contains(value) {
            return Err(format!(
                "value must be one of: {}",
                candidates
                    .iter()
                    .map(Value::to_string)
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
    }
    if let Some(number) = value.as_f64() {
        if schema.minimum.is_some_and(|minimum| number < minimum) {
            return Err(format!(
                "value must be at least {}",
                schema.minimum.unwrap()
            ));
        }
        if schema.maximum.is_some_and(|maximum| number > maximum) {
            return Err(format!("value must be at most {}", schema.maximum.unwrap()));
        }
    }
    if let Some(text) = value.as_str() {
        let length = text.chars().count();
        if schema.min_length.is_some_and(|minimum| length < minimum) {
            return Err(format!(
                "value must contain at least {} characters",
                schema.min_length.unwrap()
            ));
        }
        if schema.max_length.is_some_and(|maximum| length > maximum) {
            return Err(format!(
                "value must contain at most {} characters",
                schema.max_length.unwrap()
            ));
        }
    }
    Ok(())
}

fn schema_type_matches(expected: &str, value: &Value) -> bool {
    match expected {
        "boolean" => value.is_boolean(),
        "string" => value.is_string(),
        "integer" => value.as_i64().is_some() || value.as_u64().is_some(),
        "number" => value.is_number(),
        "object" => value.is_object(),
        "array" => value.is_array(),
        "null" => value.is_null(),
        _ => false,
    }
}

fn validate_json_schema_value(schema: &Value, value: &Value, path: &str) -> Result<(), String> {
    let schema = schema
        .as_object()
        .ok_or_else(|| format!("{path} has an invalid input schema"))?;
    if let Some(expected) = schema.get("type").and_then(Value::as_str) {
        if !schema_type_matches(expected, value) {
            return Err(format!("{path} must match type {expected}"));
        }
    }
    if let Some(candidates) = schema.get("enum").and_then(Value::as_array) {
        if !candidates.contains(value) {
            return Err(format!(
                "{path} must be one of: {}",
                candidates
                    .iter()
                    .map(Value::to_string)
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
    }
    if let Some(expected) = schema.get("const") {
        if expected != value {
            return Err(format!("{path} must equal {expected}"));
        }
    }
    if let Some(number) = value.as_f64() {
        if schema
            .get("minimum")
            .and_then(Value::as_f64)
            .is_some_and(|minimum| number < minimum)
        {
            return Err(format!("{path} is below the allowed minimum"));
        }
        if schema
            .get("maximum")
            .and_then(Value::as_f64)
            .is_some_and(|maximum| number > maximum)
        {
            return Err(format!("{path} exceeds the allowed maximum"));
        }
    }
    if let Some(text) = value.as_str() {
        let length = text.chars().count() as u64;
        if schema
            .get("minLength")
            .and_then(Value::as_u64)
            .is_some_and(|minimum| length < minimum)
        {
            return Err(format!("{path} is shorter than the allowed minimum"));
        }
        if schema
            .get("maxLength")
            .and_then(Value::as_u64)
            .is_some_and(|maximum| length > maximum)
        {
            return Err(format!("{path} is longer than the allowed maximum"));
        }
    }
    if let Some(values) = value.as_array() {
        if let Some(item_schema) = schema.get("items") {
            for (index, item) in values.iter().enumerate() {
                validate_json_schema_value(item_schema, item, &format!("{path}[{index}]"))?;
            }
        }
    }
    if let Some(object) = value.as_object() {
        let properties = schema
            .get("properties")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        if schema.get("additionalProperties") == Some(&Value::Bool(false)) {
            if let Some(unknown) = object.keys().find(|key| !properties.contains_key(*key)) {
                return Err(format!("{path}.{unknown} is not a supported argument"));
            }
        }
        for required in schema
            .get("required")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            if !object.contains_key(required) {
                return Err(format!("{path}.{required} is required"));
            }
        }
        for (key, property_schema) in properties {
            if let Some(property_value) = object.get(&key) {
                validate_json_schema_value(
                    &property_schema,
                    property_value,
                    &format!("{path}.{key}"),
                )?;
            }
        }
    }
    if let Some(alternatives) = schema.get("anyOf").and_then(Value::as_array) {
        if !alternatives
            .iter()
            .any(|alternative| validate_json_schema_value(alternative, value, path).is_ok())
        {
            return Err(format!(
                "{path} must satisfy at least one allowed argument shape"
            ));
        }
    }
    Ok(())
}

/// Validate a user-level operation payload before it reaches a product adapter.
///
/// The semantic catalog intentionally supports a small, deterministic JSON
/// Schema subset so every delivery surface enforces the same contract without
/// embedding host-specific command DTOs in the Agent tool.
pub fn validate_operation_arguments(
    input_schema: &Value,
    arguments: Option<&Value>,
) -> Result<(), String> {
    let empty = json!({});
    validate_json_schema_value(input_schema, arguments.unwrap_or(&empty), "arguments")
}

/// Reject product-host-local path arguments when the Agent is bound to a
/// remote workspace. Callers may still use stable IDs returned by a native
/// provider, which avoids ambiguous controller/target path semantics.
pub fn validate_operation_argument_scopes(
    operation: &ProductCapabilityOperation,
    arguments: Option<&Value>,
    is_remote_workspace: bool,
) -> Result<(), String> {
    if !is_remote_workspace || operation.argument_scopes.is_empty() {
        return Ok(());
    }
    let Some(arguments) = arguments.and_then(Value::as_object) else {
        return Ok(());
    };
    for (argument, scope) in &operation.argument_scopes {
        if !arguments
            .get(argument)
            .is_some_and(|value| !value.is_null())
        {
            continue;
        }
        match scope {
            ProductControlArgumentScope::ProductHostLocal => {
                return Err(format!(
                    "arguments.{argument} is a local OpenBitFun product-host path and is unavailable in a remote workspace session; use a stable resource ID returned by the provider instead"
                ));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::product_control_owner_registry::{owner_definitions, ProductControlOwnerDefinition};

    fn request(action: ProductControlAction, query: Option<&str>) -> ProductControlRequest {
        ProductControlRequest {
            action,
            query: query.map(str::to_string),
            capability_id: None,
            item_id: None,
            operation_id: None,
            option_id: None,
            arguments: None,
            value: None,
            cursor: None,
            limit: None,
            source: ProductControlSource::Compatibility,
        }
    }

    #[test]
    fn acronym_matches_require_consecutive_initials_instead_of_scattered_prose() {
        assert!(score_text_match("gs", &["Global Search"]) > 0);
        assert_eq!(
            score_text_match(
                "pet",
                &["Publish the example after completing checks and tests"]
            ),
            0
        );
        assert_eq!(
            score_text_match(
                "mascot",
                &["Move an app; select controls only when observed, then operate them"]
            ),
            0
        );
    }

    #[test]
    fn generated_catalog_is_loadable_and_curated() {
        let catalog = catalog().unwrap();
        assert_eq!(catalog.capabilities.len(), catalog.counts.user_facing);
        assert_eq!(catalog.counts.control_coverage.unsupported, 0);
        assert_eq!(
            catalog.counts.control_coverage.direct
                + catalog.counts.control_coverage.delegated
                + catalog.counts.control_coverage.interactive,
            catalog.counts.documented_items
        );
        assert!(catalog
            .capabilities
            .iter()
            .all(|capability| capability.id.starts_with("feature.")
                || capability.id.starts_with("setting.")));
        assert_eq!(catalog.digest.len(), 64);
        assert_eq!(catalog.owner_digest.len(), 64);
    }

    #[test]
    fn compiled_owner_registry_exactly_resolves_the_executable_graph() {
        let registry = ProductControlRegistry::global();
        let owner_definitions = owner_definitions();
        let executable_count: usize = registry
            .graph()
            .unwrap()
            .capabilities
            .iter()
            .map(|capability| capability.options.len() + capability.operations.len())
            .sum();
        assert_eq!(owner_definitions.len(), executable_count);

        for owner in owner_definitions {
            let definition_id = match owner {
                ProductControlOwnerDefinition::Option {
                    capability_id,
                    option_id,
                    ..
                } => {
                    registry.option(&capability_id, &option_id).unwrap();
                    format!("{capability_id}:option:{option_id}")
                }
                ProductControlOwnerDefinition::Operation {
                    capability_id,
                    operation_id,
                    ..
                } => {
                    registry.operation(&capability_id, &operation_id).unwrap();
                    format!("{capability_id}:operation:{operation_id}")
                }
            };
            assert_eq!(
                registry.definition(&definition_id).unwrap().id,
                definition_id
            );
        }
    }

    #[test]
    fn discovery_is_paginated_without_a_total_catalog_size_ceiling() {
        let mut first_request = request(ProductControlAction::List, None);
        first_request.limit = Some(1);
        let first = discover(&first_request).unwrap();
        assert_eq!(
            first["totalCount"].as_u64(),
            Some(catalog().unwrap().capabilities.len() as u64)
        );
        assert_eq!(first["items"].as_array().map(Vec::len), Some(1));
        assert_eq!(first["nextCursor"], 1);

        let mut second_request = first_request;
        second_request.cursor = Some(1);
        let second = discover(&second_request).unwrap();
        assert_ne!(first["items"][0]["id"], second["items"][0]["id"]);
    }

    #[test]
    fn caller_source_is_audit_metadata_not_behavior_selection() {
        let mut gui = request(ProductControlAction::Search, Some("工具调用超时"));
        gui.source = ProductControlSource::Gui;
        let mut agent = gui.clone();
        agent.source = ProductControlSource::Agent;
        let mut peer = gui.clone();
        peer.source = ProductControlSource::Peer;

        assert_eq!(discover(&gui).unwrap(), discover(&agent).unwrap());
        assert_eq!(discover(&gui).unwrap(), discover(&peer).unwrap());
    }

    #[test]
    fn delivery_profiles_degrade_explicitly_without_local_fallback() {
        let registry = ProductControlRegistry::global();
        for definition in &registry.graph().unwrap().definitions {
            for profile in [
                ProductControlDeliveryProfile::Desktop,
                ProductControlDeliveryProfile::Cli,
                ProductControlDeliveryProfile::Peer,
                ProductControlDeliveryProfile::RemoteControl,
                ProductControlDeliveryProfile::DetachedDispatch,
            ] {
                let availability = definition.availability.get(&profile).unwrap_or_else(|| {
                    panic!("{} is missing availability for {profile:?}", definition.id)
                });
                if !availability.available {
                    assert!(
                        availability
                            .reason
                            .as_deref()
                            .is_some_and(|reason| !reason.trim().is_empty()),
                        "{} silently degrades for {profile:?}",
                        definition.id
                    );
                }
            }
        }

        let shared_config = registry
            .definition("setting.tools.execution:option:tool-timeout-seconds")
            .unwrap();
        assert!(shared_config.availability[&ProductControlDeliveryProfile::Cli].available);

        let native_provider = registry
            .definition("setting.application.general:option:prevent-sleep")
            .unwrap();
        assert!(!native_provider.availability[&ProductControlDeliveryProfile::Cli].available);

        let presentation = registry
            .definition("feature.ai-assistant:operation:new-session")
            .unwrap();
        assert!(!presentation.availability[&ProductControlDeliveryProfile::Cli].available);
        assert!(presentation.availability[&ProductControlDeliveryProfile::Peer].available);
    }

    #[test]
    fn miniapp_lifecycle_is_discoverable_and_headless_profiles_degrade_explicitly() {
        let registry = ProductControlRegistry::global();
        for operation in [
            "list-apps",
            "inspect-app",
            "create-app",
            "update-app",
            "delete-app",
        ] {
            let definition = registry
                .definition(&format!("feature.miniapps:operation:{operation}"))
                .unwrap();
            assert!(definition.availability[&ProductControlDeliveryProfile::Desktop].available);
            for profile in [
                ProductControlDeliveryProfile::Cli,
                ProductControlDeliveryProfile::DetachedDispatch,
            ] {
                let state = &definition.availability[&profile];
                assert!(!state.available);
                assert!(state
                    .reason
                    .as_ref()
                    .is_some_and(|reason| !reason.is_empty()));
            }
        }
        let update = registry
            .operation("feature.miniapps", "update-app")
            .unwrap();
        validate_operation_arguments(
            &update.input_schema,
            Some(&json!({ "appId": "installed-id", "expectedVersion": 2, "css": "body {}" })),
        )
        .unwrap();
        validate_operation_argument_scopes(
            update,
            Some(&json!({"appId": "installed-id", "css": "body {}"})),
            true,
        )
        .unwrap();
        assert!(validate_operation_arguments(
            &update.input_schema,
            Some(&json!({ "appId": "installed-id", "expectedVersion": 0 }))
        )
        .is_err());
    }

    #[test]
    fn mcp_controls_are_direct_with_versioned_edits_and_host_availability() {
        let registry = ProductControlRegistry::global();
        let capability = capability("setting.tools.mcp").unwrap();
        for item in capability.items.iter().filter(|item| {
            matches!(
                item.id.as_str(),
                "json-config" | "server-types" | "lifecycle" | "status"
            )
        }) {
            let control = serde_json::to_value(&item.control).unwrap();
            assert_eq!(control["kind"], "direct", "{}", item.id);
        }
        for id in [
            "list-servers",
            "configure-server",
            "start-server",
            "stop-server",
            "restart-server",
            "delete-server",
        ] {
            let definition = registry
                .definition(&format!("setting.tools.mcp:operation:{id}"))
                .unwrap();
            assert!(definition.availability[&ProductControlDeliveryProfile::Desktop].available);
            assert!(
                definition.availability[&ProductControlDeliveryProfile::RemoteControl].available
            );
            let peer = &definition.availability[&ProductControlDeliveryProfile::Peer];
            assert!(peer
                .required_capabilities
                .iter()
                .any(|value| value == "product_control_native_v1"));
            for profile in [
                ProductControlDeliveryProfile::Cli,
                ProductControlDeliveryProfile::DetachedDispatch,
            ] {
                let availability = &definition.availability[&profile];
                assert!(!availability.available);
                assert!(availability.reason.is_some());
            }
        }
        let configure = registry
            .operation("setting.tools.mcp", "configure-server")
            .unwrap();
        let args = json!({"serverId":"docs", "expectedFingerprint":"observed", "config":{"url":"https://example.test/mcp", "autoStart":false}});
        validate_operation_arguments(&configure.input_schema, Some(&args)).unwrap();
        validate_operation_argument_scopes(configure, Some(&args), true).unwrap();
        for invalid in [
            json!({"serverId":"docs", "config":{"url":"https://example.test/mcp"}}),
            json!({"serverId":"docs", "expectedFingerprint":"observed", "config":{"env":{"TOKEN":"secret"}}}),
            json!({"serverId":"docs", "expectedFingerprint":"observed", "config":{"autoStart":"false"}}),
        ] {
            assert!(validate_operation_arguments(&configure.input_schema, Some(&invalid)).is_err());
        }
        let mut remote_path = args;
        remote_path["workingDirectory"] = json!("/remote/workspace");
        assert!(validate_operation_argument_scopes(configure, Some(&remote_path), true).is_err());
        assert_eq!(
            registry
                .operation("setting.tools.mcp", "list-servers")
                .unwrap()
                .risk,
            ProductControlRisk::Read
        );
        assert_eq!(
            registry
                .operation("setting.tools.mcp", "delete-server")
                .unwrap()
                .risk,
            ProductControlRisk::Destructive
        );
    }

    #[test]
    fn discovery_satisfies_the_shared_cross_surface_acceptance_corpus() {
        let catalog = catalog().unwrap();
        for acceptance in &catalog.search_acceptance {
            let result = discover(&request(
                ProductControlAction::Search,
                Some(&acceptance.query),
            ))
            .unwrap();
            let items = result["items"].as_array().unwrap();
            let ids: Vec<&str> = result["items"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|item| item["id"].as_str())
                .collect();
            assert_eq!(
                items.first().and_then(|item| item["id"].as_str()),
                Some(acceptance.expected_first_capability_id.as_str()),
                "acceptance={}",
                acceptance.id
            );
            for capability_id in &acceptance.expected_capability_ids {
                assert!(
                    ids.contains(&capability_id.as_str()),
                    "acceptance={} missed {capability_id}",
                    acceptance.id
                );
            }
            if let Some(expected_item) = &acceptance.expected_item {
                let capability = items
                    .iter()
                    .find(|item| item["id"] == expected_item.capability_id)
                    .unwrap_or_else(|| panic!("{} capability result", acceptance.id));
                assert_eq!(
                    capability["matchedItems"]
                        .as_array()
                        .and_then(|items| items.first())
                        .and_then(|item| item["itemId"].as_str()),
                    Some(expected_item.item_id.as_str()),
                    "acceptance={} item route",
                    acceptance.id
                );
                let matched_item = capability["matchedItems"]
                    .as_array()
                    .and_then(|items| items.first())
                    .unwrap();
                assert_eq!(
                    matched_item["capabilityId"].as_str(),
                    Some(expected_item.capability_id.as_str()),
                    "acceptance={} matched item capability route",
                    acceptance.id
                );
            }
        }
    }

    #[test]
    fn discovery_routes_use_unambiguous_product_control_field_names() {
        let result = discover(&request(
            ProductControlAction::Search,
            Some("deferred tool loading"),
        ))
        .unwrap();
        let capability = &result["items"][0];
        assert_eq!(capability["capabilityId"], "setting.tools.execution");
        assert_eq!(capability["id"], capability["capabilityId"]);
        assert_eq!(capability["nextAction"]["action"], "get");
        assert_eq!(
            capability["nextAction"]["capabilityId"],
            capability["capabilityId"]
        );
        assert_eq!(capability["nextToolCall"]["action"], "get");
        assert_eq!(
            capability["nextToolCall"]["capability_id"],
            capability["capabilityId"]
        );
        let matched_item = &capability["matchedItems"][0];
        assert_eq!(matched_item["capabilityId"], capability["capabilityId"]);
        assert_eq!(matched_item["itemId"], "deferred-tools");
        assert_eq!(matched_item["id"], matched_item["itemId"]);
    }

    #[test]
    fn discovery_excludes_unrelated_capabilities_before_control_ranking() {
        let result = discover(&request(
            ProductControlAction::Search,
            Some("火星量子烤面包机"),
        ))
        .unwrap();
        assert_eq!(result["totalCount"], 0);
        assert_eq!(result["items"], json!([]));
    }

    #[test]
    fn delegated_routes_are_typed_and_self_contained() {
        for capability in &catalog().unwrap().capabilities {
            for item in &capability.items {
                if let ProductCapabilityItemControl::Delegate {
                    tools,
                    workflow_zh,
                    workflow_en,
                } = &item.control
                {
                    assert!(!tools.is_empty(), "{}.{} tools", capability.id, item.id);
                    assert!(!workflow_zh.is_empty(), "{}.{} zh", capability.id, item.id);
                    assert_eq!(
                        workflow_zh.len(),
                        workflow_en.len(),
                        "{}.{} bilingual workflow",
                        capability.id,
                        item.id
                    );
                }
            }
        }
    }

    #[test]
    fn public_inspection_never_leaks_provider_handlers() {
        let result = inspect_contract("setting.application.pet").unwrap();
        assert!(!result.to_string().contains("handler"));
    }

    #[test]
    fn request_wire_shape_is_camel_case_and_typed() {
        let mut request = request(ProductControlAction::Execute, None);
        request.capability_id = Some("setting.application.pet".to_string());
        request.operation_id = Some("use-pet".to_string());
        request.arguments = Some(json!({ "path": "/tmp/pet" }));
        let value = serde_json::to_value(request).unwrap();
        assert_eq!(value["action"], "execute");
        assert_eq!(value["capabilityId"], "setting.application.pet");
        assert_eq!(value["operationId"], "use-pet");
        assert_eq!(value["arguments"]["path"], "/tmp/pet");
    }

    #[test]
    fn operation_arguments_enforce_required_types_alternatives_and_unknown_fields() {
        let capability = capability("setting.application.pet").unwrap();
        let operation = capability
            .operations
            .iter()
            .find(|operation| operation.id == "use-pet")
            .unwrap();
        assert!(validate_operation_arguments(
            &operation.input_schema,
            Some(&json!({ "path": "/tmp/pet" }))
        )
        .is_ok());
        assert!(validate_operation_arguments(
            &operation.input_schema,
            Some(&json!({ "id": "mochi-21" }))
        )
        .is_ok());
        assert!(
            validate_operation_arguments(&operation.input_schema, Some(&json!({})))
                .unwrap_err()
                .contains("allowed argument shape")
        );
        assert!(validate_operation_arguments(
            &operation.input_schema,
            Some(&json!({ "path": 42 }))
        )
        .unwrap_err()
        .contains("must match type string"));
        assert!(validate_operation_arguments(
            &operation.input_schema,
            Some(&json!({ "path": "/tmp/pet", "surprise": true }))
        )
        .unwrap_err()
        .contains("not a supported argument"));
    }

    #[test]
    fn option_values_enforce_nullability_and_operation_string_lengths() {
        let timeout = capability("setting.tools.execution")
            .unwrap()
            .options
            .iter()
            .find(|option| option.id == "tool-timeout-seconds")
            .unwrap();
        assert!(validate_option_value(&timeout.value_schema, &Value::Null).is_ok());

        let pet_operation = capability("setting.application.pet")
            .unwrap()
            .operations
            .iter()
            .find(|operation| operation.id == "use-pet")
            .unwrap();
        assert!(validate_operation_arguments(
            &pet_operation.input_schema,
            Some(&json!({ "path": "" }))
        )
        .is_err());
        assert!(validate_operation_arguments(
            &pet_operation.input_schema,
            Some(&json!({ "path": "/tmp/萌宠" }))
        )
        .is_ok());
        assert!(validate_operation_argument_scopes(
            pet_operation,
            Some(&json!({ "id": "mochi" })),
            true,
        )
        .is_ok());
        assert!(validate_operation_argument_scopes(
            pet_operation,
            Some(&json!({ "path": "/remote/project/pet" })),
            true,
        )
        .unwrap_err()
        .contains("product-host path"));
    }

    #[test]
    fn open_targets_reject_stale_item_ids_before_surface_dispatch() {
        assert!(
            validate_open_target("setting.application.shortcuts", Some("shortcut-browser")).is_ok()
        );
        assert!(
            validate_open_target("setting.application.shortcuts", Some("removed-setting-row"))
                .unwrap_err()
                .contains("Unknown documented item")
        );
    }

    #[test]
    fn diagnostics_log_level_accepts_off_and_rejects_unknown_levels() {
        let log_level = capability("setting.data.diagnostics")
            .unwrap()
            .options
            .iter()
            .find(|option| option.id == "log-level")
            .unwrap();
        for level in ["trace", "debug", "info", "warn", "error", "off"] {
            assert!(
                validate_option_value(&log_level.value_schema, &Value::String(level.into()))
                    .is_ok(),
                "log level '{level}' should be accepted"
            );
        }
        assert!(
            validate_option_value(&log_level.value_schema, &Value::String("verbose".into()))
                .unwrap_err()
                .contains("value must be one of")
        );
    }
}
