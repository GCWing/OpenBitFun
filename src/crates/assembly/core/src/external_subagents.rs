//! Product-level activation and routing for provider-neutral external subagents.
//!
//! Ecosystem parsing stays in adapters and discovery lifecycle stays in the
//! external-sources coordinator. This module only resolves current OpenBitFun
//! model/tool facts, applies persisted user decisions, and installs immutable
//! generation entries in the existing agent registry.

use crate::agentic::agents::{
    external_subagent_runtime_key, get_agent_registry, AgentInfo, AgentSource,
    ExternalProvidedAgent, ExternalSubagentModelBinding, ExternalSubagentRegistration,
    ExternalSubagentRoute,
};
use crate::agentic::tools::registry::get_all_registered_tools;
use crate::agentic::workspace::workspace_route_key;
use crate::external_sources::safe_external_source_location;
use crate::external_tools::resolve_external_tool_for_workspace;
use crate::infrastructure::ai::reasoning_catalog::{
    load_models_dev_reasoning_catalog_without_refresh, project_model_reasoning_catalog,
    resolve_default_reasoning_preset,
};
use crate::service::config::global::GlobalConfigManager;
use crate::service::config::types::{model_runtime_binding_fingerprint, AIConfig, AIModelConfig};
use crate::util::OpenBitFunError;
use openbitfun_ai_adapters::models_dev::ModelsDevCatalog;
use openbitfun_external_sources::ExternalSubagentCoordinatorSnapshot;
use openbitfun_product_domains::external_sources::EcosystemId;
use openbitfun_product_domains::external_sources::{ExternalSourceScope, ProviderId, SourceKey};
use openbitfun_product_domains::external_subagents::{
    external_subagent_approval_key, external_subagent_conflict_key,
    external_subagent_model_binding_key, ExternalSubagentActivationState,
    ExternalSubagentCompatibilityState, ExternalSubagentConflict,
    ExternalSubagentConflictCandidate, ExternalSubagentDefinition,
    ExternalSubagentDiagnosticSummary, ExternalSubagentModelBindingGroup,
    ExternalSubagentModelBindingMethod, ExternalSubagentModelBindingOption,
    ExternalSubagentModelBindingTarget, ExternalSubagentModelRequest, ExternalSubagentSummary,
    ExternalSubagentToolCapability,
};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

pub(super) const DISABLED_SUBAGENT_CONFLICT_CHOICE: &str = "__openbitfun_disabled__";
static MODEL_CONFIG_UNAVAILABLE_LOGGED: AtomicBool = AtomicBool::new(false);

pub(super) struct ExternalSubagentDecisions<'a> {
    pub active_ecosystems: &'a BTreeSet<EcosystemId>,
    pub approved_envelopes: &'a BTreeSet<String>,
    pub declined_decisions: &'a BTreeMap<String, String>,
    pub conflict_choices: &'a BTreeMap<String, String>,
    pub conflict_lineage_current_keys: &'a BTreeMap<String, String>,
    pub model_bindings: &'a BTreeMap<String, ExternalSubagentModelBindingTarget>,
}

#[derive(Default)]
pub(super) struct ExternalSubagentProductState {
    pub summaries: Vec<ExternalSubagentSummary>,
    pub conflicts: Vec<ExternalSubagentConflict>,
    pub pending_approvals: Vec<String>,
    pub model_binding_groups: Vec<ExternalSubagentModelBindingGroup>,
    pub model_binding_options: Vec<ExternalSubagentModelBindingOption>,
    pub registrations: Vec<ExternalSubagentRegistration>,
    pub routes: BTreeMap<String, ExternalSubagentRoute>,
    pub observed_conflict_lineage_current_keys: BTreeMap<String, String>,
}

#[derive(Clone)]
struct ResolvedToolFact {
    name: String,
    binding_fingerprint: String,
    readonly: bool,
}

#[derive(Clone)]
struct LocalCandidateFact {
    logical_id: String,
    candidate_id: String,
    display_name: String,
    source_label: String,
    behavior_version: String,
}

#[derive(Default)]
struct ProductFacts {
    ai_config: Option<AIConfig>,
    models_dev: Option<Arc<ModelsDevCatalog>>,
    tools: BTreeMap<String, ResolvedToolFact>,
    locals: BTreeMap<String, LocalCandidateFact>,
}

struct ResolvedExternalCandidate {
    definition: ExternalSubagentDefinition,
    ecosystem_id: Option<EcosystemId>,
    provider_label: String,
    scope: ExternalSourceScope,
    source_keys: Vec<SourceKey>,
    source_location_labels: Vec<String>,
    model: ResolvedCandidateModel,
    model_binding_method: ExternalSubagentModelBindingMethod,
    model_binding_key: Option<String>,
    selected_model_binding_target: Option<ExternalSubagentModelBindingTarget>,
    tools: Vec<ResolvedToolFact>,
    unavailable_tool_labels: Vec<String>,
    readonly: bool,
    activation_envelope: String,
    approval_key: String,
    conflict_behavior_version: String,
    diagnostics: Vec<ExternalSubagentDiagnosticSummary>,
    compatibility: ExternalSubagentCompatibilityState,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum ResolvedCandidateModel {
    Fixed(ResolvedModelFact),
    InheritParent,
    Unavailable,
}

impl ResolvedCandidateModel {
    fn effective_label(&self) -> Option<&str> {
        match self {
            Self::Fixed(model) => Some(model.display_label.as_str()),
            Self::InheritParent | Self::Unavailable => None,
        }
    }

    fn approval_identity(&self) -> (&str, &str) {
        match self {
            Self::Fixed(model) => (&model.runtime_id, &model.configuration_fingerprint),
            Self::InheritParent => ("inherit_parent", "inherit_parent_v1"),
            Self::Unavailable => ("unavailable", "unavailable"),
        }
    }
}

struct ResolvedModelRequest {
    model: ResolvedCandidateModel,
    method: ExternalSubagentModelBindingMethod,
    binding_key: Option<String>,
    selected_target: Option<ExternalSubagentModelBindingTarget>,
}

pub(super) async fn reconcile_external_subagents(
    workspace_id: Option<&str>,
    workspace_root: Option<&Path>,
    execution_domain_id: &str,
    snapshot: &ExternalSubagentCoordinatorSnapshot,
    decisions: ExternalSubagentDecisions<'_>,
) -> ExternalSubagentProductState {
    let facts = gather_product_facts(workspace_id, &snapshot.definitions).await;
    reconcile_with_facts(
        workspace_id,
        workspace_root,
        execution_domain_id,
        snapshot,
        decisions,
        &facts,
    )
}

/// Static projection for read-only Hosts. It never reads model configuration,
/// the tool registry, or the agent registry, and it never produces routes or
/// runtime registrations.
pub(super) fn project_external_subagents_read_only(
    workspace_id: Option<&str>,
    workspace_root: Option<&Path>,
    execution_domain_id: &str,
    snapshot: &ExternalSubagentCoordinatorSnapshot,
    decisions: ExternalSubagentDecisions<'_>,
) -> ExternalSubagentProductState {
    let source_map = snapshot
        .sources
        .iter()
        .map(|entry| (entry.record.key.clone(), &entry.record))
        .collect::<BTreeMap<_, _>>();
    let facts = ProductFacts::default();
    let mut state = ExternalSubagentProductState::default();
    for definition in &snapshot.definitions {
        let resolved = resolve_external_candidate(
            workspace_id,
            workspace_root,
            execution_domain_id,
            definition,
            &source_map,
            &snapshot.provider_labels,
            &facts,
            decisions.model_bindings,
        );
        let ecosystem_active = resolved.source_keys.iter().all(|source_key| {
            source_map
                .get(source_key)
                .is_some_and(|source| decisions.active_ecosystems.contains(&source.ecosystem_id))
        });
        let activation = if !ecosystem_active || resolved.definition.disabled {
            ExternalSubagentActivationState::Disabled
        } else if decisions
            .approved_envelopes
            .contains(&resolved.approval_key)
        {
            ExternalSubagentActivationState::Unavailable
        } else if decisions
            .declined_decisions
            .get(&resolved.approval_key)
            .is_some_and(|decision| decision == &resolved.approval_key)
        {
            ExternalSubagentActivationState::Declined
        } else {
            state.pending_approvals.push(resolved.approval_key.clone());
            ExternalSubagentActivationState::ApprovalRequired
        };
        state.summaries.push(summary_for(&resolved, activation));
    }
    state.summaries.sort_by(|left, right| {
        left.logical_id
            .cmp(&right.logical_id)
            .then(left.candidate_id.cmp(&right.candidate_id))
    });
    state.pending_approvals.sort();
    state.pending_approvals.dedup();
    state
}

async fn gather_product_facts(
    workspace_id: Option<&str>,
    definitions: &[ExternalSubagentDefinition],
) -> ProductFacts {
    let ai_config = match GlobalConfigManager::get_service().await {
        Ok(service) => match service.get_config::<AIConfig>(Some("ai")).await {
            Ok(config) => {
                MODEL_CONFIG_UNAVAILABLE_LOGGED.store(false, Ordering::Relaxed);
                Some(config)
            }
            Err(error) => {
                log_model_config_unavailable("config_read", &error);
                None
            }
        },
        Err(error) => {
            log_model_config_unavailable("config_service", &error);
            None
        }
    };
    let models_dev = if ai_config.is_some() {
        load_models_dev_reasoning_catalog_without_refresh()
            .await
            .catalog
    } else {
        None
    };

    let requested_names = definitions
        .iter()
        .flat_map(|definition| &definition.requested_tools.selectors)
        .filter(|selector| selector.allowed)
        .filter_map(|selector| {
            selector
                .canonical_capability
                .map(host_tool_name)
                .map(str::to_string)
        })
        .collect::<BTreeSet<_>>();
    let mut tools = BTreeMap::new();
    for registered in get_all_registered_tools().await {
        let name = registered.name().to_string();
        if !requested_names.contains(&name) {
            continue;
        }
        let Some(selected) = resolve_external_tool_for_workspace(registered, workspace_id) else {
            continue;
        };
        if !selected.is_enabled().await {
            continue;
        }
        let metadata = selected
            .dynamic_tool_info()
            .and_then(|info| serde_json::to_string(&info).ok())
            .unwrap_or_default();
        let readonly = selected.is_readonly();
        tools.insert(
            name.clone(),
            ResolvedToolFact {
                name: name.clone(),
                binding_fingerprint: stable_digest([
                    name.as_str(),
                    metadata.as_str(),
                    if readonly { "readonly" } else { "writable" },
                    if readonly {
                        "unpermissioned"
                    } else {
                        "permissioned"
                    },
                ]),
                readonly,
            },
        );
    }

    let registry = get_agent_registry();
    let mut locals = BTreeMap::new();
    for info in registry
        .get_local_agents_for_external_resolution(workspace_id)
        .await
    {
        let logical_key = normalize_logical_id(&info.id);
        if locals.contains_key(&logical_key) {
            // AgentRegistry currently resolves the first global entry before a
            // project entry. Preserve that effective local route rather than
            // offering a candidate that the Local route could not execute.
            continue;
        }
        let model = match (info.subagent_source, ai_config.as_ref()) {
            // Main-agent profiles do not own the mutable session model. Their
            // conflict identity is the profile itself; the user's current
            // model selection must not invalidate an external-source choice.
            (None, _) => "main-agent-profile".to_string(),
            (Some(_), Some(ai_config)) => {
                let model_selection = registry
                    .get_explicit_subagent_model_selection(&info.id, workspace_id)
                    .unwrap_or_else(|| {
                        ai_config
                            .agent_model_defaults
                            .builtin_subagent_selection(&info.id)
                    });
                serde_json::to_string(&model_selection)
                    .unwrap_or_else(|_| "unavailable".to_string())
            }
            (Some(_), None) => "configuration-unavailable".to_string(),
        };
        locals.insert(logical_key, local_candidate_fact(&info, &model));
    }

    ProductFacts {
        ai_config,
        models_dev,
        tools,
        locals,
    }
}

fn host_tool_name(capability: ExternalSubagentToolCapability) -> &'static str {
    match capability {
        ExternalSubagentToolCapability::DirectoryList => "LS",
        ExternalSubagentToolCapability::ReadFile => "Read",
        ExternalSubagentToolCapability::GlobFiles => "Glob",
        ExternalSubagentToolCapability::SearchText => "Grep",
        ExternalSubagentToolCapability::ExecuteCommand => "ExecCommand",
        ExternalSubagentToolCapability::EditFile => "Edit",
        ExternalSubagentToolCapability::WriteFile => "Write",
    }
}

fn log_model_config_unavailable(stage: &str, error: &OpenBitFunError) {
    if claim_model_config_outage_log(&MODEL_CONFIG_UNAVAILABLE_LOGGED) {
        log::warn!(
            "External subagent model configuration unavailable: stage={}, category={}",
            stage,
            model_config_error_category(error)
        );
    }
}

fn claim_model_config_outage_log(logged: &AtomicBool) -> bool {
    !logged.swap(true, Ordering::Relaxed)
}

fn model_config_error_category(error: &OpenBitFunError) -> &'static str {
    match error {
        OpenBitFunError::Configuration(message) if message.contains("not initialized") => {
            "service_not_initialized"
        }
        OpenBitFunError::Configuration(message) if message.contains("service is None") => {
            "service_missing"
        }
        OpenBitFunError::Configuration(message)
            if message.contains("Failed to deserialize config value") =>
        {
            "config_deserialization_failed"
        }
        OpenBitFunError::Configuration(message) if message.contains("Config path") => {
            "config_path_unavailable"
        }
        OpenBitFunError::Configuration(_) => "configuration_error",
        OpenBitFunError::Deserialization(_) => "deserialization_error",
        OpenBitFunError::Serialization(_) => "serialization_error",
        OpenBitFunError::Io(_) => "io_error",
        OpenBitFunError::Service(_) => "service_error",
        _ => "other_error",
    }
}

fn local_candidate_fact(info: &AgentInfo, model: &str) -> LocalCandidateFact {
    let mut tools = info.default_tools.clone();
    tools.sort();
    let source = match info.source {
        AgentSource::Builtin => "OpenBitFun built-in",
        AgentSource::User => "OpenBitFun user",
        AgentSource::Project => "OpenBitFun project",
        AgentSource::External => "External",
    };
    let path_identity = info.path.as_deref().unwrap_or_default();
    let candidate_id = format!(
        "local_subagent:{}",
        stable_digest([
            &format!("{:?}", info.source),
            info.id.as_str(),
            path_identity,
        ])
    );
    let behavior_version = stable_digest(
        [
            info.prompt_cache_scope_key.as_str(),
            model,
            if info.is_readonly {
                "readonly"
            } else {
                "writable"
            },
            if info.is_review { "review" } else { "standard" },
            if info.effective_enabled {
                "enabled"
            } else {
                "disabled"
            },
        ]
        .into_iter()
        .chain(tools.iter().map(String::as_str)),
    );
    LocalCandidateFact {
        logical_id: info.id.clone(),
        candidate_id,
        display_name: info.name.clone(),
        source_label: source.to_string(),
        behavior_version,
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ResolvedModelFact {
    runtime_id: String,
    display_label: String,
    configuration_fingerprint: String,
}

fn model_display_label(model: &AIModelConfig) -> String {
    let provider = model.name.trim();
    let model_name = model.model_name.trim();
    if provider.is_empty() {
        model_name.to_string()
    } else {
        format!("{provider} · {model_name}")
    }
}

fn normalize_model_provider(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn resolve_exact_external_model(
    provider_hint: Option<&str>,
    model_name: &str,
    ai_config: &AIConfig,
) -> Option<ResolvedModelFact> {
    let model_name = model_name.trim();
    if model_name.is_empty() {
        return None;
    }

    if provider_hint.is_none() {
        let mut id_matches = ai_config
            .models
            .iter()
            .filter(|model| model.enabled && model.id == model_name);
        if let Some(model) = id_matches.next() {
            if id_matches.next().is_none() {
                return Some(resolved_model_fact(model));
            }
            return None;
        }
    }

    let mut matches = ai_config
        .models
        .iter()
        .filter(|model| model.enabled)
        .filter(|model| {
            if model.model_name != model_name {
                return false;
            }
            provider_hint.is_none_or(|provider| {
                [model.provider.as_str(), model.name.as_str()]
                    .into_iter()
                    .map(normalize_model_provider)
                    .any(|candidate| candidate == normalize_model_provider(provider))
            })
        });
    let model = matches.next()?;
    if matches.next().is_some() {
        return None;
    }
    Some(resolved_model_fact(model))
}

fn resolved_model_fact(model: &AIModelConfig) -> ResolvedModelFact {
    ResolvedModelFact {
        runtime_id: model.id.clone(),
        display_label: model_display_label(model),
        configuration_fingerprint: model_runtime_binding_fingerprint(model),
    }
}

fn configured_reasoning_effort(
    model: &AIModelConfig,
    models_dev: Option<&ModelsDevCatalog>,
) -> Option<String> {
    resolve_default_reasoning_preset(&project_model_reasoning_catalog(model, models_dev))
        .and_then(|preset| {
            preset.actions.iter().rev().find_map(|action| match action {
                openbitfun_core_types::ReasoningPresetAction::Effort { value } => {
                    Some(value.clone())
                }
                _ => None,
            })
        })
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn resolve_model_binding_target(
    target: &ExternalSubagentModelBindingTarget,
    ai_config: &AIConfig,
) -> Option<ResolvedModelFact> {
    let runtime_id = match target {
        ExternalSubagentModelBindingTarget::Primary => {
            ai_config.resolve_model_selection("primary")?
        }
        ExternalSubagentModelBindingTarget::Fast => ai_config.resolve_model_selection("fast")?,
        ExternalSubagentModelBindingTarget::Model { model_id } => {
            ai_config.resolve_model_reference(model_id)?
        }
    };
    ai_config
        .models
        .iter()
        .find(|model| model.enabled && model.id == runtime_id)
        .map(resolved_model_fact)
}

fn external_model_binding_options(
    ai_config: &AIConfig,
    models_dev: Option<&ModelsDevCatalog>,
) -> Vec<ExternalSubagentModelBindingOption> {
    let mut options = Vec::new();
    for target in [
        ExternalSubagentModelBindingTarget::Primary,
        ExternalSubagentModelBindingTarget::Fast,
    ] {
        if let Some(model) = resolve_model_binding_target(&target, ai_config) {
            options.push(ExternalSubagentModelBindingOption {
                target,
                effective_model_label: model.display_label,
                configured_reasoning_effort: ai_config
                    .models
                    .iter()
                    .find(|candidate| candidate.enabled && candidate.id == model.runtime_id)
                    .and_then(|model| configured_reasoning_effort(model, models_dev)),
            });
        }
    }
    let mut configured = ai_config
        .models
        .iter()
        .filter(|model| model.enabled)
        .map(|model| ExternalSubagentModelBindingOption {
            target: ExternalSubagentModelBindingTarget::Model {
                model_id: model.id.clone(),
            },
            effective_model_label: model_display_label(model),
            configured_reasoning_effort: configured_reasoning_effort(model, models_dev),
        })
        .collect::<Vec<_>>();
    let label_counts =
        configured
            .iter()
            .fold(BTreeMap::<String, usize>::new(), |mut counts, option| {
                *counts
                    .entry(option.effective_model_label.clone())
                    .or_default() += 1;
                counts
            });
    for option in &mut configured {
        if label_counts
            .get(&option.effective_model_label)
            .copied()
            .unwrap_or_default()
            > 1
        {
            let ExternalSubagentModelBindingTarget::Model { model_id } = &option.target else {
                continue;
            };
            option.effective_model_label = format!("{} · {model_id}", option.effective_model_label);
        }
    }
    configured.sort_by(|left, right| {
        left.effective_model_label
            .cmp(&right.effective_model_label)
            .then(left.target.cmp(&right.target))
    });
    options.extend(configured);
    options
}

fn resolve_model_request(
    definition: &ExternalSubagentDefinition,
    ecosystem_id: Option<&EcosystemId>,
    scope: ExternalSourceScope,
    workspace_scope: &str,
    execution_domain_id: &str,
    ai_config: Option<&AIConfig>,
    model_bindings: &BTreeMap<String, ExternalSubagentModelBindingTarget>,
) -> ResolvedModelRequest {
    let (automatic_model, automatic_method) = match &definition.requested_model {
        // An omitted external model means "use the caller's current model" in
        // both OpenCode and Claude Code. It must not be guessed from a
        // same-name OpenBitFun subagent default: that couples an external profile
        // to an unrelated local definition and changes behavior on collisions.
        ExternalSubagentModelRequest::Default => (
            if ai_config.is_some() {
                ResolvedCandidateModel::InheritParent
            } else {
                ResolvedCandidateModel::Unavailable
            },
            ExternalSubagentModelBindingMethod::Default,
        ),
        ExternalSubagentModelRequest::Inherit => (
            if ai_config.is_some() {
                ResolvedCandidateModel::InheritParent
            } else {
                ResolvedCandidateModel::Unavailable
            },
            ExternalSubagentModelBindingMethod::Inherit,
        ),
        ExternalSubagentModelRequest::Reference {
            provider_hint,
            model_name,
        } => (
            ai_config
                .and_then(|config| {
                    resolve_exact_external_model(provider_hint.as_deref(), model_name, config)
                })
                .map(ResolvedCandidateModel::Fixed)
                .unwrap_or(ResolvedCandidateModel::Unavailable),
            ExternalSubagentModelBindingMethod::Exact,
        ),
    };
    let binding_key = ecosystem_id.and_then(|ecosystem_id| {
        external_subagent_model_binding_key(
            ecosystem_id,
            &definition.requested_model,
            definition.requested_model_profile.as_ref(),
            execution_domain_id,
            scope,
            workspace_scope,
        )
    });
    let exact_reference_unavailable =
        matches!(
            &definition.requested_model,
            ExternalSubagentModelRequest::Reference { .. }
        ) && matches!(&automatic_model, ResolvedCandidateModel::Unavailable);
    let needs_binding_path =
        definition.requested_model_profile.is_some() || exact_reference_unavailable;
    if !needs_binding_path {
        return ResolvedModelRequest {
            model: automatic_model,
            method: automatic_method,
            binding_key,
            selected_target: None,
        };
    }

    let selected_target = binding_key
        .as_ref()
        .and_then(|key| model_bindings.get(key))
        .cloned();
    match (ai_config, selected_target.clone()) {
        (Some(config), Some(target)) => match resolve_model_binding_target(&target, config) {
            Some(model) => ResolvedModelRequest {
                model: ResolvedCandidateModel::Fixed(model),
                method: ExternalSubagentModelBindingMethod::Explicit,
                binding_key,
                selected_target: Some(target),
            },
            None => ResolvedModelRequest {
                model: ResolvedCandidateModel::Unavailable,
                method: ExternalSubagentModelBindingMethod::BindingUnavailable,
                binding_key,
                selected_target: Some(target),
            },
        },
        (Some(_), None) => ResolvedModelRequest {
            model: ResolvedCandidateModel::Unavailable,
            method: ExternalSubagentModelBindingMethod::BindingRequired,
            binding_key,
            selected_target: None,
        },
        (None, target) => ResolvedModelRequest {
            model: ResolvedCandidateModel::Unavailable,
            method: ExternalSubagentModelBindingMethod::BindingUnavailable,
            binding_key,
            selected_target: target,
        },
    }
}

fn reconcile_with_facts(
    workspace_id: Option<&str>,
    workspace_root: Option<&Path>,
    execution_domain_id: &str,
    snapshot: &ExternalSubagentCoordinatorSnapshot,
    decisions: ExternalSubagentDecisions<'_>,
    facts: &ProductFacts,
) -> ExternalSubagentProductState {
    let workspace_scope = workspace_scope_key(workspace_id);
    let source_map = snapshot
        .sources
        .iter()
        .map(|entry| (entry.record.key.clone(), &entry.record))
        .collect::<BTreeMap<_, _>>();
    let mut state = ExternalSubagentProductState::default();
    let mut model_binding_groups = BTreeMap::<String, ExternalSubagentModelBindingGroup>::new();
    let mut by_logical = BTreeMap::<String, Vec<ResolvedExternalCandidate>>::new();

    for definition in &snapshot.definitions {
        let resolved = resolve_external_candidate(
            workspace_id,
            workspace_root,
            execution_domain_id,
            definition,
            &source_map,
            &snapshot.provider_labels,
            facts,
            decisions.model_bindings,
        );
        let ecosystem_active = resolved.source_keys.iter().all(|source_key| {
            source_map
                .get(source_key)
                .is_some_and(|source| decisions.active_ecosystems.contains(&source.ecosystem_id))
        });
        if !ecosystem_active {
            state.summaries.push(summary_for(
                &resolved,
                ExternalSubagentActivationState::Disabled,
            ));
            continue;
        }
        let summary = summary_for(&resolved, initial_activation_state(&resolved));
        if facts.ai_config.is_none() {
            if !resolved.definition.disabled {
                state.routes.insert(
                    resolved.definition.logical_id.clone(),
                    ExternalSubagentRoute::Unavailable,
                );
            }
            state.summaries.push(summary);
            continue;
        }
        if resolved.definition.disabled {
            state.summaries.push(summary);
            continue;
        }
        collect_model_binding_group(&resolved, &mut model_binding_groups);
        if matches!(
            resolved.compatibility,
            ExternalSubagentCompatibilityState::Blocked
                | ExternalSubagentCompatibilityState::Invalid
        ) {
            state.summaries.push(summary);
            continue;
        }
        if has_runtime_unavailable_diagnostic(&resolved) {
            state.summaries.push(summary);
            continue;
        }
        by_logical
            .entry(normalize_logical_id(&definition.logical_id))
            .or_default()
            .push(resolved);
    }

    if facts.ai_config.is_none() {
        for lineage in decisions.conflict_lineage_current_keys.keys() {
            if let Some((domain, scope, logical_id)) = parse_conflict_lineage(lineage) {
                if domain == execution_domain_id && scope == workspace_scope {
                    state
                        .routes
                        .insert(logical_id.to_string(), ExternalSubagentRoute::Unavailable);
                }
            }
        }
        state.summaries.sort_by(|left, right| {
            left.logical_id
                .cmp(&right.logical_id)
                .then(left.candidate_id.cmp(&right.candidate_id))
        });
        finalize_model_binding_catalog(
            &mut state,
            model_binding_groups,
            facts.ai_config.as_ref(),
            facts.models_dev.as_deref(),
        );
        return state;
    }

    let tracked_logical_ids = decisions
        .conflict_lineage_current_keys
        .keys()
        .filter_map(|lineage| {
            let (domain, scope, logical_id) = parse_conflict_lineage(lineage)?;
            (domain == execution_domain_id && scope == workspace_scope)
                .then(|| (normalize_logical_id(logical_id), logical_id.to_string()))
        })
        .collect::<BTreeMap<_, _>>();
    let logical_keys = by_logical
        .keys()
        .cloned()
        .chain(tracked_logical_ids.keys().cloned())
        .collect::<BTreeSet<_>>();

    for logical_key in logical_keys {
        let mut external_candidates = by_logical.remove(&logical_key).unwrap_or_default();
        external_candidates.sort_by(|left, right| {
            left.definition
                .candidate_id
                .cmp(&right.definition.candidate_id)
        });
        let local = facts.locals.get(&logical_key);
        let logical_id = external_candidates
            .first()
            .map(|candidate| candidate.definition.logical_id.clone())
            .or_else(|| local.map(|candidate| candidate.logical_id.clone()))
            .or_else(|| tracked_logical_ids.get(&logical_key).cloned())
            .unwrap_or(logical_key);
        let participant_count = external_candidates.len() + usize::from(local.is_some());
        let lineage = conflict_lineage(execution_domain_id, &workspace_scope, &logical_id);
        let previously_conflicted = decisions
            .conflict_lineage_current_keys
            .contains_key(&lineage);
        if participant_count == 0 && previously_conflicted {
            let conflict_key = external_subagent_conflict_key(
                execution_domain_id,
                &workspace_scope,
                &logical_id,
                std::iter::empty::<(&str, &str)>(),
            );
            state
                .observed_conflict_lineage_current_keys
                .insert(lineage, conflict_key);
            state
                .routes
                .insert(logical_id, ExternalSubagentRoute::Unavailable);
        } else if participant_count > 1 || previously_conflicted {
            reconcile_conflict_group(
                execution_domain_id,
                &workspace_scope,
                &logical_id,
                local,
                external_candidates,
                &decisions,
                &mut state,
            );
        } else if let Some(candidate) = external_candidates.pop() {
            reconcile_nonconflicting_candidate(candidate, &decisions, &mut state);
        }
    }

    state.summaries.sort_by(|left, right| {
        left.logical_id
            .cmp(&right.logical_id)
            .then(left.candidate_id.cmp(&right.candidate_id))
    });
    state.conflicts.sort_by(|left, right| {
        left.logical_id
            .cmp(&right.logical_id)
            .then(left.conflict_key.cmp(&right.conflict_key))
    });
    state.pending_approvals.sort();
    state.pending_approvals.dedup();
    finalize_model_binding_catalog(
        &mut state,
        model_binding_groups,
        facts.ai_config.as_ref(),
        facts.models_dev.as_deref(),
    );
    state
}

fn finalize_model_binding_catalog(
    state: &mut ExternalSubagentProductState,
    groups: BTreeMap<String, ExternalSubagentModelBindingGroup>,
    ai_config: Option<&AIConfig>,
    models_dev: Option<&ModelsDevCatalog>,
) {
    state.model_binding_groups = finalized_model_binding_groups(groups);
    if state.model_binding_groups.iter().any(|group| {
        matches!(
            group.method,
            ExternalSubagentModelBindingMethod::BindingRequired
                | ExternalSubagentModelBindingMethod::Explicit
                | ExternalSubagentModelBindingMethod::BindingUnavailable
        )
    }) {
        state.model_binding_options = ai_config
            .map(|config| external_model_binding_options(config, models_dev))
            .unwrap_or_default();
    }
}

fn collect_model_binding_group(
    candidate: &ResolvedExternalCandidate,
    groups: &mut BTreeMap<String, ExternalSubagentModelBindingGroup>,
) {
    let Some(binding_key) = candidate.model_binding_key.as_ref() else {
        return;
    };
    let group =
        groups
            .entry(binding_key.clone())
            .or_insert_with(|| ExternalSubagentModelBindingGroup {
                binding_key: binding_key.clone(),
                request: candidate.definition.requested_model.clone(),
                profile_request: candidate.definition.requested_model_profile.clone(),
                scope: candidate.scope,
                method: candidate.model_binding_method,
                selected_target: candidate.selected_model_binding_target.clone(),
                effective_model_label: candidate.model.effective_label().map(str::to_string),
                affected_candidate_ids: Vec::new(),
            });
    group
        .affected_candidate_ids
        .push(candidate.definition.candidate_id.as_str().to_string());
}

fn finalized_model_binding_groups(
    groups: BTreeMap<String, ExternalSubagentModelBindingGroup>,
) -> Vec<ExternalSubagentModelBindingGroup> {
    groups
        .into_values()
        .map(|mut group| {
            group.affected_candidate_ids.sort();
            group.affected_candidate_ids.dedup();
            group
        })
        .collect()
}

fn resolve_external_candidate(
    workspace_id: Option<&str>,
    workspace_root: Option<&Path>,
    execution_domain_id: &str,
    definition: &ExternalSubagentDefinition,
    sources: &BTreeMap<
        SourceKey,
        &openbitfun_product_domains::external_sources::ExternalSourceRecord,
    >,
    provider_labels: &BTreeMap<ProviderId, String>,
    facts: &ProductFacts,
    model_bindings: &BTreeMap<String, ExternalSubagentModelBindingTarget>,
) -> ResolvedExternalCandidate {
    let mut compatibility = definition.compatibility;
    let mut diagnostics = definition
        .diagnostic_codes
        .iter()
        .map(|code| ExternalSubagentDiagnosticSummary {
            code: code.clone(),
            blocks_activation: matches!(
                compatibility,
                ExternalSubagentCompatibilityState::Blocked
                    | ExternalSubagentCompatibilityState::Invalid
            ),
        })
        .collect::<Vec<_>>();
    let mut source_location_labels = Vec::new();
    let mut source_keys = Vec::new();
    let mut scope = ExternalSourceScope::UserGlobal;
    let mut ecosystem_id = None;
    for item in &definition.provenance {
        if let Some(source) = sources.get(&item.contribution_id.source) {
            ecosystem_id.get_or_insert_with(|| source.ecosystem_id.clone());
            if !source_keys.contains(&source.key) {
                source_keys.push(source.key.clone());
            }
            let location_label =
                safe_external_source_location(source.scope, &source.location, workspace_root);
            if !source_location_labels.contains(&location_label) {
                source_location_labels.push(location_label);
            }
            if scope_rank(source.scope) >= scope_rank(scope) {
                scope = source.scope;
            }
        }
    }
    if ecosystem_id.is_none() {
        compatibility = ExternalSubagentCompatibilityState::Invalid;
        diagnostics.push(ExternalSubagentDiagnosticSummary {
            code: "external_subagent.source_unavailable".to_string(),
            blocks_activation: true,
        });
    }
    let model_resolution = resolve_model_request(
        definition,
        ecosystem_id.as_ref(),
        scope,
        &workspace_scope_key(workspace_id),
        execution_domain_id,
        facts.ai_config.as_ref(),
        model_bindings,
    );
    if facts.ai_config.is_none() {
        diagnostics.push(ExternalSubagentDiagnosticSummary {
            code: "external_subagent.configuration_unavailable".to_string(),
            blocks_activation: true,
        });
    } else if matches!(model_resolution.model, ResolvedCandidateModel::Unavailable) {
        let code = match model_resolution.method {
            ExternalSubagentModelBindingMethod::BindingRequired => {
                "external_subagent.model_binding_required"
            }
            ExternalSubagentModelBindingMethod::BindingUnavailable => {
                "external_subagent.model_binding_unavailable"
            }
            _ => "external_subagent.model_unavailable",
        };
        if !matches!(
            model_resolution.method,
            ExternalSubagentModelBindingMethod::BindingUnavailable
        ) {
            compatibility = ExternalSubagentCompatibilityState::Blocked;
        }
        diagnostics.push(ExternalSubagentDiagnosticSummary {
            code: code.to_string(),
            blocks_activation: true,
        });
    }

    let mut tools = Vec::new();
    let mut unavailable_tool_labels = Vec::new();
    for selector in definition
        .requested_tools
        .selectors
        .iter()
        .filter(|selector| selector.allowed)
    {
        let Some(capability) = selector.canonical_capability else {
            if matches!(compatibility, ExternalSubagentCompatibilityState::Ready) {
                compatibility = ExternalSubagentCompatibilityState::ReadyWithDegradation;
            }
            unavailable_tool_labels.push(selector.source_name.clone());
            diagnostics.push(ExternalSubagentDiagnosticSummary {
                code: "external_subagent.tool_unavailable".to_string(),
                blocks_activation: false,
            });
            continue;
        };
        let name = host_tool_name(capability);
        match facts.tools.get(name) {
            Some(tool) => tools.push(tool.clone()),
            None => {
                compatibility = ExternalSubagentCompatibilityState::Blocked;
                unavailable_tool_labels.push(name.to_string());
                diagnostics.push(ExternalSubagentDiagnosticSummary {
                    code: "external_subagent.tool_unavailable".to_string(),
                    blocks_activation: true,
                });
            }
        }
    }
    tools.sort_by(|left, right| left.name.cmp(&right.name));
    tools.dedup_by(|left, right| left.name == right.name);
    unavailable_tool_labels.sort();
    unavailable_tool_labels.dedup();
    diagnostics.sort_by(|left, right| left.code.cmp(&right.code));
    diagnostics.dedup_by(|left, right| left.code == right.code);
    let readonly = tools.iter().all(|tool| tool.readonly);
    let permission_constraints = serde_json::to_string(&definition.permission_constraints)
        .expect("validated permission constraints serialize");
    let provenance = definition
        .provenance
        .iter()
        .map(|item| item.contribution_id.stable_key())
        .collect::<Vec<_>>();
    let (model_approval_id, model_approval_fingerprint) =
        model_resolution.model.approval_identity();
    let activation_envelope = stable_digest(
        [
            execution_domain_id,
            definition.candidate_id.as_str(),
            &format!("{:?}", definition.mode),
            model_approval_id,
            model_approval_fingerprint,
            if definition.hidden {
                "hidden"
            } else {
                "visible"
            },
            if readonly { "readonly" } else { "writable" },
            permission_constraints.as_str(),
        ]
        .into_iter()
        .chain(provenance.iter().map(String::as_str))
        .chain(
            tools
                .iter()
                .flat_map(|tool| [tool.name.as_str(), tool.binding_fingerprint.as_str()]),
        )
        .chain(
            diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.blocks_activation)
                .map(|diagnostic| diagnostic.code.as_str()),
        ),
    );
    let approval_key = external_subagent_approval_key(
        &definition.candidate_id,
        &definition.behavior_version,
        &activation_envelope,
    );
    let conflict_behavior_version = stable_digest([
        definition.behavior_version.as_str(),
        activation_envelope.as_str(),
    ]);
    let provider_id = definition
        .provenance
        .first()
        .map(|item| &item.contribution_id.source.provider_id);
    let provider_label = provider_id
        .and_then(|provider_id| provider_labels.get(provider_id))
        .cloned()
        .unwrap_or_else(|| "External AI app".to_string());
    ResolvedExternalCandidate {
        definition: definition.clone(),
        ecosystem_id,
        provider_label,
        scope,
        source_keys,
        source_location_labels,
        model: model_resolution.model,
        model_binding_method: model_resolution.method,
        model_binding_key: model_resolution.binding_key,
        selected_model_binding_target: model_resolution.selected_target,
        tools,
        unavailable_tool_labels,
        readonly,
        activation_envelope,
        approval_key,
        conflict_behavior_version,
        diagnostics,
        compatibility,
    }
}

fn reconcile_nonconflicting_candidate(
    candidate: ResolvedExternalCandidate,
    decisions: &ExternalSubagentDecisions<'_>,
    state: &mut ExternalSubagentProductState,
) {
    let activation = if decisions
        .approved_envelopes
        .contains(&candidate.approval_key)
    {
        install_active_candidate(&candidate, state);
        ExternalSubagentActivationState::Active
    } else if decisions
        .declined_decisions
        .contains_key(&candidate.approval_key)
    {
        ExternalSubagentActivationState::Declined
    } else {
        state
            .pending_approvals
            .push(candidate.definition.candidate_id.as_str().to_string());
        ExternalSubagentActivationState::ApprovalRequired
    };
    state.summaries.push(summary_for(&candidate, activation));
}

fn reconcile_conflict_group(
    execution_domain_id: &str,
    workspace_scope: &str,
    logical_id: &str,
    local: Option<&LocalCandidateFact>,
    external_candidates: Vec<ResolvedExternalCandidate>,
    decisions: &ExternalSubagentDecisions<'_>,
    state: &mut ExternalSubagentProductState,
) {
    let mut key_participants = external_candidates
        .iter()
        .map(|candidate| {
            (
                candidate.definition.candidate_id.as_str(),
                candidate.conflict_behavior_version.as_str(),
            )
        })
        .collect::<Vec<_>>();
    if let Some(local) = local {
        key_participants.push((&local.candidate_id, &local.behavior_version));
    }
    let conflict_key = external_subagent_conflict_key(
        execution_domain_id,
        workspace_scope,
        logical_id,
        key_participants,
    );
    let lineage = conflict_lineage(execution_domain_id, workspace_scope, logical_id);
    state
        .observed_conflict_lineage_current_keys
        .insert(lineage, conflict_key.clone());
    let selected = decisions
        .conflict_choices
        .get(&conflict_key)
        .filter(|selected| {
            *selected == DISABLED_SUBAGENT_CONFLICT_CHOICE
                || local.is_some_and(|local| &local.candidate_id == *selected)
                || external_candidates.iter().any(|candidate| {
                    candidate.definition.candidate_id.as_str() == selected.as_str()
                })
        })
        .cloned();

    let mut conflict_candidates = Vec::new();
    if let Some(local) = local {
        conflict_candidates.push(ExternalSubagentConflictCandidate {
            candidate_id: local.candidate_id.clone(),
            display_name: local.display_name.clone(),
            source_label: local.source_label.clone(),
            external: false,
        });
    }
    for candidate in &external_candidates {
        conflict_candidates.push(ExternalSubagentConflictCandidate {
            candidate_id: candidate.definition.candidate_id.as_str().to_string(),
            display_name: candidate.definition.display_name.clone(),
            source_label: candidate.provider_label.clone(),
            external: true,
        });
    }
    match selected.as_deref() {
        Some(selected_id) if selected_id == DISABLED_SUBAGENT_CONFLICT_CHOICE => {
            state
                .routes
                .insert(logical_id.to_string(), ExternalSubagentRoute::Unavailable);
        }
        Some(selected_id)
            if local.is_some_and(|candidate| candidate.candidate_id == selected_id) =>
        {
            state
                .routes
                .insert(logical_id.to_string(), ExternalSubagentRoute::Local);
        }
        Some(selected_id) => {
            if let Some(candidate) = external_candidates
                .iter()
                .find(|candidate| candidate.definition.candidate_id.as_str() == selected_id)
            {
                if decisions
                    .approved_envelopes
                    .contains(&candidate.approval_key)
                {
                    install_active_candidate(candidate, state);
                } else {
                    state
                        .routes
                        .insert(logical_id.to_string(), ExternalSubagentRoute::Unavailable);
                }
            }
        }
        None => {
            state
                .routes
                .insert(logical_id.to_string(), ExternalSubagentRoute::Unavailable);
        }
    }

    for candidate in external_candidates {
        let activation = if selected.as_deref() == Some(candidate.definition.candidate_id.as_str())
            && decisions
                .approved_envelopes
                .contains(&candidate.approval_key)
        {
            ExternalSubagentActivationState::Active
        } else if selected.is_some() {
            ExternalSubagentActivationState::Disabled
        } else {
            ExternalSubagentActivationState::Conflict
        };
        state.summaries.push(summary_for(&candidate, activation));
    }
    state.conflicts.push(ExternalSubagentConflict {
        conflict_key,
        logical_id: logical_id.to_string(),
        candidates: conflict_candidates,
        selected_candidate_id: selected,
    });
}

fn install_active_candidate(
    candidate: &ResolvedExternalCandidate,
    state: &mut ExternalSubagentProductState,
) {
    let Some(ecosystem_id) = candidate.ecosystem_id.clone() else {
        return;
    };
    let runtime_key = external_subagent_runtime_key(&stable_digest([
        candidate.definition.candidate_id.as_str(),
        candidate.definition.behavior_version.as_str(),
        candidate.activation_envelope.as_str(),
    ]));
    let tools = candidate
        .tools
        .iter()
        .map(|tool| tool.name.clone())
        .collect::<Vec<_>>();
    // Source-owned catalog copy is intentionally excluded from AgentInfo. The
    // existing <available_agents> projection is model-visible, so allowing a
    // description-only update there would mutate prompt context without a new
    // behavior approval. Keep that projection host-owned and stable while the
    // review surface continues to show the source description.
    let runtime_description = format!(
        "Approved external agent profile from {}.",
        candidate.provider_label
    );
    let agent = Arc::new(ExternalProvidedAgent::new(
        runtime_key.clone(),
        candidate.definition.display_name.clone(),
        runtime_description,
        candidate.definition.prompt.expose().to_string(),
        tools,
        candidate.definition.permission_constraints.clone(),
        None,
        candidate.readonly,
        candidate.definition.behavior_version.as_str().to_string(),
    ));
    let model_binding = match &candidate.model {
        ResolvedCandidateModel::Fixed(model) => ExternalSubagentModelBinding::Fixed {
            model_id: model.runtime_id.clone(),
            configuration_fingerprint: model.configuration_fingerprint.clone(),
        },
        ResolvedCandidateModel::InheritParent => ExternalSubagentModelBinding::InheritParent,
        ResolvedCandidateModel::Unavailable => return,
    };
    state.registrations.push(ExternalSubagentRegistration {
        runtime_key: runtime_key.clone(),
        logical_id: candidate.definition.logical_id.clone(),
        route_key: format!(
            "{}:{}",
            ecosystem_id.as_str(),
            candidate.definition.candidate_id.as_str()
        ),
        ecosystem_id,
        provider_label: candidate.provider_label.clone(),
        model_binding,
        hidden: candidate.definition.hidden,
        mode: candidate.definition.mode,
        agent,
    });
    state.routes.insert(
        candidate.definition.logical_id.clone(),
        ExternalSubagentRoute::External(runtime_key),
    );
}

fn summary_for(
    candidate: &ResolvedExternalCandidate,
    activation_state: ExternalSubagentActivationState,
) -> ExternalSubagentSummary {
    ExternalSubagentSummary {
        candidate_id: candidate.definition.candidate_id.as_str().to_string(),
        logical_id: candidate.definition.logical_id.clone(),
        display_name: candidate.definition.display_name.clone(),
        description: candidate.definition.description.clone(),
        provider_label: candidate.provider_label.clone(),
        scope: candidate.scope,
        source_keys: candidate.source_keys.clone(),
        source_location_labels: candidate.source_location_labels.clone(),
        source_count: candidate.definition.provenance.len(),
        mode: candidate.definition.mode,
        requested_model: candidate.definition.requested_model.clone(),
        requested_model_profile: candidate.definition.requested_model_profile.clone(),
        model_binding_method: candidate.model_binding_method,
        model_binding_key: candidate.model_binding_key.clone(),
        effective_model_label: candidate.model.effective_label().map(str::to_string),
        effective_tool_labels: candidate
            .tools
            .iter()
            .map(|tool| tool.name.clone())
            .collect(),
        unavailable_tool_labels: candidate.unavailable_tool_labels.clone(),
        supports_follow_up: false,
        compatibility_state: candidate.compatibility,
        diagnostics: candidate.diagnostics.clone(),
        activation_state,
        decision_key: candidate.approval_key.clone(),
    }
}

fn initial_activation_state(
    candidate: &ResolvedExternalCandidate,
) -> ExternalSubagentActivationState {
    if candidate.definition.disabled {
        ExternalSubagentActivationState::Disabled
    } else if matches!(
        candidate.compatibility,
        ExternalSubagentCompatibilityState::Blocked | ExternalSubagentCompatibilityState::Invalid
    ) {
        ExternalSubagentActivationState::Blocked
    } else if has_runtime_unavailable_diagnostic(candidate) {
        ExternalSubagentActivationState::Unavailable
    } else {
        ExternalSubagentActivationState::ApprovalRequired
    }
}

fn has_runtime_unavailable_diagnostic(candidate: &ResolvedExternalCandidate) -> bool {
    candidate.diagnostics.iter().any(|diagnostic| {
        matches!(
            diagnostic.code.as_str(),
            "external_subagent.configuration_unavailable"
                | "external_subagent.model_binding_unavailable"
        ) && diagnostic.blocks_activation
    })
}

fn workspace_scope_key(workspace_id: Option<&str>) -> String {
    workspace_route_key(workspace_id)
}

fn normalize_logical_id(value: &str) -> String {
    value.to_ascii_lowercase()
}

fn conflict_lineage(execution_domain_id: &str, workspace_scope: &str, logical_id: &str) -> String {
    [
        execution_domain_id,
        workspace_scope,
        &normalize_logical_id(logical_id),
    ]
    .into_iter()
    .map(|part| format!("{}:{part}", part.len()))
    .collect()
}

fn parse_conflict_lineage(value: &str) -> Option<(&str, &str, &str)> {
    let (domain, rest) = take_length_prefixed(value)?;
    let (scope, rest) = take_length_prefixed(rest)?;
    let (logical_id, rest) = take_length_prefixed(rest)?;
    rest.is_empty().then_some((domain, scope, logical_id))
}

fn take_length_prefixed(value: &str) -> Option<(&str, &str)> {
    let colon = value.find(':')?;
    let length = value[..colon].parse::<usize>().ok()?;
    let rest = &value[colon + 1..];
    let part = rest.get(..length)?;
    Some((part, rest.get(length..)?))
}

fn scope_rank(scope: ExternalSourceScope) -> u8 {
    match scope {
        ExternalSourceScope::UserGlobal => 0,
        ExternalSourceScope::Project => 1,
        ExternalSourceScope::WorkspaceLocal => 2,
        ExternalSourceScope::RemoteUser => 3,
        ExternalSourceScope::RemoteProject => 4,
        _ => 0,
    }
}

fn stable_digest(parts: impl IntoIterator<Item = impl AsRef<str>>) -> String {
    let mut hasher = Sha256::new();
    for part in parts {
        let value = part.as_ref();
        hasher.update(value.len().to_le_bytes());
        hasher.update(value.as_bytes());
    }
    hex::encode(hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::config::SubagentModelSelection;

    fn test_active_ecosystems() -> &'static BTreeSet<EcosystemId> {
        static ECOSYSTEMS: std::sync::OnceLock<BTreeSet<EcosystemId>> = std::sync::OnceLock::new();
        ECOSYSTEMS.get_or_init(|| {
            BTreeSet::from([EcosystemId::new("fake").expect("valid test ecosystem")])
        })
    }

    fn empty_model_bindings() -> &'static BTreeMap<String, ExternalSubagentModelBindingTarget> {
        static BINDINGS: std::sync::OnceLock<BTreeMap<String, ExternalSubagentModelBindingTarget>> =
            std::sync::OnceLock::new();
        BINDINGS.get_or_init(BTreeMap::new)
    }
    use openbitfun_product_domains::external_sources::{
        EcosystemId, ExecutionDomainId, ExternalSourceCatalogEntry, ExternalSourceHealth,
        ExternalSourceLifecycleState, ExternalSourceRecord,
    };
    use openbitfun_product_domains::external_subagents::{
        ExternalSubagentBehaviorVersion, ExternalSubagentCandidateId,
        ExternalSubagentContributionId, ExternalSubagentContributionRole, ExternalSubagentLocalId,
        ExternalSubagentMode, ExternalSubagentModelBindingMethod,
        ExternalSubagentModelBindingTarget, ExternalSubagentModelProfileRequest,
        ExternalSubagentProvenanceRef, ExternalSubagentToolCapability, ExternalSubagentToolRequest,
        ExternalSubagentToolSelector, SecretText,
    };
    use openbitfun_product_domains::tool_permissions::{
        PermissionConstraintLayer, PermissionEffect, PermissionRule,
    };

    fn definition(behavior: &str, catalog: &str) -> (ExternalSubagentDefinition, SourceKey) {
        let source = SourceKey::new("fake-provider", "agents/reviewer.md").unwrap();
        let provenance = vec![ExternalSubagentProvenanceRef {
            contribution_id: ExternalSubagentContributionId::new(
                source.clone(),
                ExternalSubagentLocalId::new("reviewer").unwrap(),
            ),
            role: ExternalSubagentContributionRole::Definition,
        }];
        (
            ExternalSubagentDefinition {
                candidate_id: ExternalSubagentCandidateId::new(
                    "external_subagent:fake:reviewer:candidate",
                )
                .unwrap(),
                logical_id: "reviewer".to_string(),
                provenance,
                display_name: "Reviewer".to_string(),
                description: catalog.to_string(),
                prompt: SecretText::new("Review the requested changes."),
                mode: ExternalSubagentMode::Subagent,
                disabled: false,
                hidden: false,
                requested_model: ExternalSubagentModelRequest::Default,
                requested_model_profile: None,
                requested_tools: ExternalSubagentToolRequest {
                    selectors: vec![ExternalSubagentToolSelector {
                        source_name: "read".to_string(),
                        canonical_capability: Some(ExternalSubagentToolCapability::ReadFile),
                        allowed: true,
                    }],
                    uses_conservative_default: false,
                },
                permission_constraints: Default::default(),
                compatibility: ExternalSubagentCompatibilityState::Ready,
                diagnostic_codes: Vec::new(),
                behavior_version: ExternalSubagentBehaviorVersion::new(behavior).unwrap(),
            },
            source,
        )
    }

    fn snapshot(behavior: &str, catalog: &str) -> ExternalSubagentCoordinatorSnapshot {
        let (definition, source) = definition(behavior, catalog);
        ExternalSubagentCoordinatorSnapshot {
            generation: 1,
            discovery_pending: false,
            provider_labels: BTreeMap::from([(
                ProviderId::new("fake-provider").unwrap(),
                "Fake AI".to_string(),
            )]),
            sources: vec![ExternalSourceCatalogEntry {
                stable_key: "source".to_string(),
                presentation_group_id: None,
                record: ExternalSourceRecord {
                    key: source,
                    ecosystem_id: EcosystemId::new("fake").unwrap(),
                    display_name: "Fake agents".to_string(),
                    source_kind: "markdown".to_string(),
                    scope: ExternalSourceScope::UserGlobal,
                    location: "agents/reviewer.md".to_string(),
                    execution_domain_id: ExecutionDomainId::new("local-user").unwrap(),
                    health: ExternalSourceHealth::Available,
                    content_version: "v1".to_string(),
                    diagnostics: Vec::new(),
                },
                lifecycle: ExternalSourceLifecycleState::Available,
            }],
            definitions: vec![definition],
            using_last_valid_provider_ids: Vec::new(),
            diagnostics: Vec::new(),
            next_refresh_deadline: None,
        }
    }

    fn facts() -> ProductFacts {
        let mut ai_config = AIConfig {
            models: vec![active_model(
                "model_fast",
                "Fast provider",
                "fake",
                "fast-model",
            )],
            ..AIConfig::default()
        };
        ai_config.default_models.fast = Some("model_fast".to_string());
        ProductFacts {
            ai_config: Some(ai_config),
            models_dev: None,
            tools: BTreeMap::from([(
                "Read".to_string(),
                ResolvedToolFact {
                    name: "Read".to_string(),
                    binding_fingerprint: "read-v1".to_string(),
                    readonly: true,
                },
            )]),
            locals: BTreeMap::new(),
        }
    }

    fn active_model(
        id: &str,
        provider_name: &str,
        provider: &str,
        model_name: &str,
    ) -> AIModelConfig {
        AIModelConfig {
            id: id.to_string(),
            name: provider_name.to_string(),
            provider: provider.to_string(),
            model_name: model_name.to_string(),
            enabled: true,
            ..AIModelConfig::default()
        }
    }

    #[test]
    fn exact_external_model_maps_provider_and_model_to_internal_config_without_exposing_id() {
        let config = AIConfig {
            models: vec![active_model(
                "model_internal_1",
                "OpenRouter",
                "openai",
                "anthropic/claude-sonnet-4",
            )],
            ..AIConfig::default()
        };

        let resolved =
            resolve_exact_external_model(Some("openrouter"), "anthropic/claude-sonnet-4", &config)
                .expect("provider/model identity should resolve");

        assert_eq!(resolved.runtime_id, "model_internal_1");
        assert_eq!(
            resolved.display_label,
            "OpenRouter · anthropic/claude-sonnet-4"
        );
        assert!(!resolved.display_label.contains("model_internal_1"));
    }

    #[test]
    fn exact_external_model_fails_closed_when_provider_model_identity_is_ambiguous() {
        let config = AIConfig {
            models: vec![
                active_model("model_a", "Anthropic", "anthropic", "claude-sonnet-4"),
                active_model("model_b", "Anthropic", "anthropic", "claude-sonnet-4"),
            ],
            ..AIConfig::default()
        };

        assert!(resolve_exact_external_model(None, "anthropic/claude-sonnet-4", &config).is_none());
        let options = external_model_binding_options(&config, None)
            .into_iter()
            .filter(|option| {
                matches!(
                    option.target,
                    ExternalSubagentModelBindingTarget::Model { .. }
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(options.len(), 2);
        assert_ne!(
            options[0].effective_model_label, options[1].effective_model_label,
            "ambiguous configured models need distinguishable binding labels"
        );
    }

    #[test]
    fn exact_external_model_prefers_a_unique_config_id_before_provider_model_matching() {
        let config = AIConfig {
            models: vec![
                active_model("review-model", "OpenAI", "openai", "gpt-5"),
                active_model("other", "Review Model", "review-model", "review-model"),
            ],
            ..AIConfig::default()
        };

        let resolved = resolve_exact_external_model(None, "review-model", &config)
            .expect("a unique config id has priority");
        assert_eq!(resolved.runtime_id, "review-model");
        assert_eq!(resolved.display_label, "OpenAI · gpt-5");
    }

    #[test]
    fn reasoning_effort_profile_requires_explicit_binding_without_guessing_runtime_support() {
        let mut definition_snapshot = snapshot("behavior-v1", "catalog-v1");
        definition_snapshot.definitions[0].requested_model =
            ExternalSubagentModelRequest::Reference {
                provider_hint: Some("fake".to_string()),
                model_name: "fast-model".to_string(),
            };
        definition_snapshot.definitions[0].requested_model_profile =
            Some(ExternalSubagentModelProfileRequest::ReasoningEffort {
                value: "high".to_string(),
            });
        let mut product_facts = facts();
        let model = &mut product_facts.ai_config.as_mut().unwrap().models[0];
        model.reasoning = Some(crate::service::config::types::ReasoningConfig {
            default_preset: Some("high".to_string()),
            presets: vec![crate::service::config::types::ReasoningPreset {
                id: "high".to_string(),
                actions: vec![
                    crate::service::config::types::ReasoningPresetAction::Effort {
                        value: "high".to_string(),
                    },
                ],
                ..Default::default()
            }],
            ..Default::default()
        });
        let empty_set = BTreeSet::new();
        let empty_decisions = BTreeMap::new();
        let empty_bindings = BTreeMap::new();

        let unbound = reconcile_with_facts(
            Some("workspace-1"),
            Some(Path::new("C:/repo")),
            "local-user",
            &definition_snapshot,
            ExternalSubagentDecisions {
                active_ecosystems: test_active_ecosystems(),
                approved_envelopes: &empty_set,
                declined_decisions: &empty_decisions,
                conflict_choices: &empty_decisions,
                conflict_lineage_current_keys: &empty_decisions,
                model_bindings: &empty_bindings,
            },
            &product_facts,
        );
        assert_eq!(
            unbound.summaries[0].model_binding_method,
            ExternalSubagentModelBindingMethod::BindingRequired
        );
        assert_eq!(unbound.model_binding_groups.len(), 1);
        assert_eq!(
            unbound.model_binding_groups[0].profile_request,
            definition_snapshot.definitions[0].requested_model_profile
        );
        let bindings = BTreeMap::from([(
            unbound.model_binding_groups[0].binding_key.clone(),
            ExternalSubagentModelBindingTarget::Fast,
        )]);
        let bound = reconcile_with_facts(
            Some("workspace-1"),
            Some(Path::new("C:/repo")),
            "local-user",
            &definition_snapshot,
            ExternalSubagentDecisions {
                active_ecosystems: test_active_ecosystems(),
                approved_envelopes: &empty_set,
                declined_decisions: &empty_decisions,
                conflict_choices: &empty_decisions,
                conflict_lineage_current_keys: &empty_decisions,
                model_bindings: &bindings,
            },
            &product_facts,
        );
        assert_eq!(
            bound.summaries[0].model_binding_method,
            ExternalSubagentModelBindingMethod::Explicit
        );
        assert_eq!(
            bound.model_binding_options[0]
                .configured_reasoning_effort
                .as_deref(),
            Some("high")
        );

        definition_snapshot.definitions[0].requested_model = ExternalSubagentModelRequest::Default;
        let default_unbound = reconcile_with_facts(
            Some("workspace-1"),
            Some(Path::new("C:/repo")),
            "local-user",
            &definition_snapshot,
            ExternalSubagentDecisions {
                active_ecosystems: test_active_ecosystems(),
                approved_envelopes: &empty_set,
                declined_decisions: &empty_decisions,
                conflict_choices: &empty_decisions,
                conflict_lineage_current_keys: &empty_decisions,
                model_bindings: &empty_bindings,
            },
            &product_facts,
        );
        assert_eq!(
            default_unbound.summaries[0].model_binding_method,
            ExternalSubagentModelBindingMethod::BindingRequired,
            "a matching configured value is not proof that the selected provider sends it"
        );
    }

    #[test]
    fn generated_default_reasoning_effort_is_projected_from_models_dev() {
        let catalog = ModelsDevCatalog::parse_str(
            r#"{
                "fake": {"models": {
                    "fast-model": {
                        "id": "fast-model",
                        "reasoning": true,
                        "reasoning_options": {"type": "effort", "values": ["low", "high"]}
                    }
                }}
            }"#,
        )
        .expect("models.dev fixture");
        let model = AIModelConfig {
            provider: "responses".to_string(),
            model_name: "fast-model".to_string(),
            base_url: "https://api.fake.example/v1".to_string(),
            reasoning: Some(crate::service::config::types::ReasoningConfig {
                catalog: openbitfun_core_types::ReasoningCatalogBinding::ModelsDev {
                    provider: "fake".to_string(),
                    model: "fast-model".to_string(),
                },
                default_preset: Some("high".to_string()),
                ..Default::default()
            }),
            ..Default::default()
        };

        assert_eq!(
            configured_reasoning_effort(&model, Some(&catalog)).as_deref(),
            Some("high")
        );
    }

    #[test]
    fn named_variant_requires_an_explicit_binding_without_guessing_source_options() {
        let mut definition_snapshot = snapshot("behavior-v1", "catalog-v1");
        definition_snapshot.definitions[0].requested_model =
            ExternalSubagentModelRequest::Reference {
                provider_hint: Some("fake".to_string()),
                model_name: "fast-model".to_string(),
            };
        definition_snapshot.definitions[0].requested_model_profile =
            Some(ExternalSubagentModelProfileRequest::NamedVariant {
                name: "high".to_string(),
            });
        let empty_set = BTreeSet::new();
        let empty_decisions = BTreeMap::new();
        let empty_bindings = BTreeMap::new();
        let product_facts = facts();

        let unbound = reconcile_with_facts(
            Some("workspace-1"),
            Some(Path::new("C:/repo")),
            "local-user",
            &definition_snapshot,
            ExternalSubagentDecisions {
                active_ecosystems: test_active_ecosystems(),
                approved_envelopes: &empty_set,
                declined_decisions: &empty_decisions,
                conflict_choices: &empty_decisions,
                conflict_lineage_current_keys: &empty_decisions,
                model_bindings: &empty_bindings,
            },
            &product_facts,
        );
        assert_eq!(
            unbound.summaries[0].model_binding_method,
            ExternalSubagentModelBindingMethod::BindingRequired
        );

        let bindings = BTreeMap::from([(
            unbound.model_binding_groups[0].binding_key.clone(),
            ExternalSubagentModelBindingTarget::Fast,
        )]);
        let bound = reconcile_with_facts(
            Some("workspace-1"),
            Some(Path::new("C:/repo")),
            "local-user",
            &definition_snapshot,
            ExternalSubagentDecisions {
                active_ecosystems: test_active_ecosystems(),
                approved_envelopes: &empty_set,
                declined_decisions: &empty_decisions,
                conflict_choices: &empty_decisions,
                conflict_lineage_current_keys: &empty_decisions,
                model_bindings: &bindings,
            },
            &product_facts,
        );
        assert_eq!(
            bound.summaries[0].model_binding_method,
            ExternalSubagentModelBindingMethod::Explicit
        );
    }

    #[test]
    fn omitted_external_model_inherits_without_consulting_local_subagent_defaults() {
        let mut product_facts = facts();
        product_facts
            .ai_config
            .as_mut()
            .expect("test AI config")
            .agent_model_defaults
            .subagents
            .default_selection = SubagentModelSelection::fixed("model_fast");
        let empty_set = BTreeSet::new();
        let empty_map = BTreeMap::new();

        let state = reconcile_with_facts(
            Some("workspace-1"),
            Some(Path::new("C:/repo")),
            "local-user",
            &snapshot("behavior-v1", "catalog-v1"),
            ExternalSubagentDecisions {
                active_ecosystems: test_active_ecosystems(),
                approved_envelopes: &empty_set,
                declined_decisions: &empty_map,
                conflict_choices: &empty_map,
                conflict_lineage_current_keys: &empty_map,
                model_bindings: empty_model_bindings(),
            },
            &product_facts,
        );

        assert_eq!(
            state.summaries[0].model_binding_method,
            ExternalSubagentModelBindingMethod::Default
        );
        assert_eq!(state.summaries[0].effective_model_label, None);
        assert_eq!(
            state.summaries[0].activation_state,
            ExternalSubagentActivationState::ApprovalRequired
        );
    }

    #[test]
    fn external_subagent_model_binding_groups_unknown_references_and_resolves_explicit_targets() {
        let mut definition_snapshot = snapshot("behavior-v1", "catalog-v1");
        definition_snapshot.definitions[0].requested_model =
            ExternalSubagentModelRequest::Reference {
                provider_hint: Some("future-provider".to_string()),
                model_name: "future-model".to_string(),
            };
        let mut product_facts = facts();
        let ai_config = product_facts.ai_config.as_mut().unwrap();
        ai_config.default_models.primary = Some("model_fast".to_string());
        let empty_set = BTreeSet::new();
        let empty_decisions = BTreeMap::new();
        let empty_bindings = BTreeMap::new();

        let unbound = reconcile_with_facts(
            Some("workspace-1"),
            Some(Path::new("C:/repo")),
            "local-user",
            &definition_snapshot,
            ExternalSubagentDecisions {
                active_ecosystems: test_active_ecosystems(),
                approved_envelopes: &empty_set,
                declined_decisions: &empty_decisions,
                conflict_choices: &empty_decisions,
                conflict_lineage_current_keys: &empty_decisions,
                model_bindings: &empty_bindings,
            },
            &product_facts,
        );

        assert_eq!(unbound.model_binding_groups.len(), 1);
        assert!(!unbound.model_binding_options.is_empty());
        let group = &unbound.model_binding_groups[0];
        assert_eq!(
            group.method,
            ExternalSubagentModelBindingMethod::BindingRequired
        );
        assert_eq!(
            group.affected_candidate_ids,
            ["external_subagent:fake:reviewer:candidate"]
        );
        assert_eq!(
            unbound.summaries[0].model_binding_method,
            ExternalSubagentModelBindingMethod::BindingRequired
        );
        assert_eq!(
            unbound.summaries[0].activation_state,
            ExternalSubagentActivationState::Blocked
        );

        let inactive_ecosystems = BTreeSet::new();
        let inactive = reconcile_with_facts(
            Some("workspace-1"),
            Some(Path::new("C:/repo")),
            "local-user",
            &definition_snapshot,
            ExternalSubagentDecisions {
                active_ecosystems: &inactive_ecosystems,
                approved_envelopes: &empty_set,
                declined_decisions: &empty_decisions,
                conflict_choices: &empty_decisions,
                conflict_lineage_current_keys: &empty_decisions,
                model_bindings: &empty_bindings,
            },
            &product_facts,
        );
        assert!(inactive.model_binding_groups.is_empty());
        assert!(inactive.model_binding_options.is_empty());

        let bindings = BTreeMap::from([(
            group.binding_key.clone(),
            ExternalSubagentModelBindingTarget::Primary,
        )]);
        let bound = reconcile_with_facts(
            Some("workspace-1"),
            Some(Path::new("C:/repo")),
            "local-user",
            &definition_snapshot,
            ExternalSubagentDecisions {
                active_ecosystems: test_active_ecosystems(),
                approved_envelopes: &empty_set,
                declined_decisions: &empty_decisions,
                conflict_choices: &empty_decisions,
                conflict_lineage_current_keys: &empty_decisions,
                model_bindings: &bindings,
            },
            &product_facts,
        );

        let group = &bound.model_binding_groups[0];
        assert_eq!(group.method, ExternalSubagentModelBindingMethod::Explicit);
        assert_eq!(
            group.selected_target,
            Some(ExternalSubagentModelBindingTarget::Primary)
        );
        assert_eq!(
            group.effective_model_label.as_deref(),
            Some("Fast provider · fast-model")
        );
        assert_eq!(
            bound.summaries[0].model_binding_method,
            ExternalSubagentModelBindingMethod::Explicit
        );
        assert_eq!(
            bound.summaries[0].activation_state,
            ExternalSubagentActivationState::ApprovalRequired
        );

        let unavailable_bindings = BTreeMap::from([(
            group.binding_key.clone(),
            ExternalSubagentModelBindingTarget::Model {
                model_id: "removed-model".to_string(),
            },
        )]);
        let unavailable = reconcile_with_facts(
            Some("workspace-1"),
            Some(Path::new("C:/repo")),
            "local-user",
            &definition_snapshot,
            ExternalSubagentDecisions {
                active_ecosystems: test_active_ecosystems(),
                approved_envelopes: &empty_set,
                declined_decisions: &empty_decisions,
                conflict_choices: &empty_decisions,
                conflict_lineage_current_keys: &empty_decisions,
                model_bindings: &unavailable_bindings,
            },
            &product_facts,
        );
        assert_eq!(
            unavailable.model_binding_groups[0].method,
            ExternalSubagentModelBindingMethod::BindingUnavailable
        );
        assert_eq!(
            unavailable.summaries[0].activation_state,
            ExternalSubagentActivationState::Unavailable
        );
    }

    #[test]
    fn external_subagent_model_binding_aggregates_matching_references_but_not_workspaces() {
        let mut definition_snapshot = snapshot("behavior-v1", "catalog-v1");
        definition_snapshot.sources[0].record.scope = ExternalSourceScope::Project;
        let request = ExternalSubagentModelRequest::Reference {
            provider_hint: None,
            model_name: "unknown-model".to_string(),
        };
        definition_snapshot.definitions[0].requested_model = request.clone();
        let mut second = definition_snapshot.definitions[0].clone();
        second.candidate_id =
            ExternalSubagentCandidateId::new("external_subagent:fake:second:candidate").unwrap();
        second.logical_id = "second".to_string();
        second.provenance[0].contribution_id.local_id =
            ExternalSubagentLocalId::new("second").unwrap();
        second.requested_model = request;
        definition_snapshot.definitions.push(second);
        let empty_set = BTreeSet::new();
        let empty_decisions = BTreeMap::new();
        let empty_bindings = BTreeMap::new();
        let decisions = ExternalSubagentDecisions {
            active_ecosystems: test_active_ecosystems(),
            approved_envelopes: &empty_set,
            declined_decisions: &empty_decisions,
            conflict_choices: &empty_decisions,
            conflict_lineage_current_keys: &empty_decisions,
            model_bindings: &empty_bindings,
        };

        let first = reconcile_with_facts(
            Some("workspace-1"),
            Some(Path::new("C:/repo-a")),
            "local-user",
            &definition_snapshot,
            decisions,
            &facts(),
        );
        assert_eq!(first.model_binding_groups.len(), 1);
        assert_eq!(
            first.model_binding_groups[0].affected_candidate_ids.len(),
            2
        );

        let second = reconcile_with_facts(
            Some("workspace-2"),
            Some(Path::new("C:/repo-a")),
            "local-user",
            &definition_snapshot,
            ExternalSubagentDecisions {
                active_ecosystems: test_active_ecosystems(),
                approved_envelopes: &empty_set,
                declined_decisions: &empty_decisions,
                conflict_choices: &empty_decisions,
                conflict_lineage_current_keys: &empty_decisions,
                model_bindings: &empty_bindings,
            },
            &facts(),
        );
        assert_ne!(
            first.model_binding_groups[0].binding_key,
            second.model_binding_groups[0].binding_key
        );
    }

    #[test]
    fn external_subagent_inherit_registers_intent_without_a_fixed_model_label() {
        let mut definition_snapshot = snapshot("behavior-v1", "catalog-v1");
        definition_snapshot.definitions[0].requested_model = ExternalSubagentModelRequest::Inherit;
        let empty_set = BTreeSet::new();
        let empty_decisions = BTreeMap::new();
        let empty_bindings = BTreeMap::new();
        let preview = reconcile_with_facts(
            Some("workspace-1"),
            Some(Path::new("C:/repo")),
            "local-user",
            &definition_snapshot,
            ExternalSubagentDecisions {
                active_ecosystems: test_active_ecosystems(),
                approved_envelopes: &empty_set,
                declined_decisions: &empty_decisions,
                conflict_choices: &empty_decisions,
                conflict_lineage_current_keys: &empty_decisions,
                model_bindings: &empty_bindings,
            },
            &facts(),
        );
        assert_eq!(
            preview.summaries[0].model_binding_method,
            ExternalSubagentModelBindingMethod::Inherit
        );
        assert_eq!(preview.summaries[0].effective_model_label, None);
        assert!(preview.model_binding_groups.is_empty());
        assert!(preview.model_binding_options.is_empty());

        let approved = BTreeSet::from([preview.summaries[0].decision_key.clone()]);
        let active = reconcile_with_facts(
            Some("workspace-1"),
            Some(Path::new("C:/repo")),
            "local-user",
            &definition_snapshot,
            ExternalSubagentDecisions {
                active_ecosystems: test_active_ecosystems(),
                approved_envelopes: &approved,
                declined_decisions: &empty_decisions,
                conflict_choices: &empty_decisions,
                conflict_lineage_current_keys: &empty_decisions,
                model_bindings: &empty_bindings,
            },
            &facts(),
        );
        assert_eq!(active.registrations.len(), 1);
        assert_eq!(
            active.registrations[0].model_binding,
            ExternalSubagentModelBinding::InheritParent
        );
    }

    #[test]
    fn source_location_labels_hide_absolute_user_and_workspace_paths() {
        assert_eq!(
            safe_external_source_location(
                ExternalSourceScope::Project,
                "C:/repo/.opencode/agents/review.md",
                Some(Path::new("C:/repo")),
            ),
            "<workspace>/.opencode/agents/review.md"
        );
        assert_eq!(
            safe_external_source_location(
                ExternalSourceScope::UserGlobal,
                "C:/Users/alice/.future-ai/agents/review.md",
                None,
            ),
            "~/.future-ai/agents/review.md"
        );
        assert_eq!(
            safe_external_source_location(
                ExternalSourceScope::UserGlobal,
                "C:/Users/alice/.config/opencode/agents/review.md",
                None,
            ),
            "~/.config/opencode/agents/review.md"
        );
        assert_eq!(
            safe_external_source_location(
                ExternalSourceScope::UserGlobal,
                "/Users/alice/.config/opencode/agents/review.md",
                None,
            ),
            "~/.config/opencode/agents/review.md"
        );
        assert_eq!(
            safe_external_source_location(
                ExternalSourceScope::Project,
                "C:\\repo\\.opencode\\agents\\review.md",
                Some(Path::new("C:\\repo")),
            ),
            "<workspace>/.opencode/agents/review.md"
        );
    }

    #[test]
    fn unavailable_openbitfun_model_config_is_recoverable_without_claiming_model_mismatch() {
        let empty_set = BTreeSet::new();
        let empty_map = BTreeMap::new();
        let definition_snapshot = snapshot("behavior-v1", "catalog-v1");
        let healthy_facts = facts();
        let preview = reconcile_with_facts(
            Some("workspace-1"),
            Some(Path::new("C:/repo")),
            "local-user",
            &definition_snapshot,
            ExternalSubagentDecisions {
                active_ecosystems: test_active_ecosystems(),
                approved_envelopes: &empty_set,
                declined_decisions: &empty_map,
                conflict_choices: &empty_map,
                conflict_lineage_current_keys: &empty_map,
                model_bindings: empty_model_bindings(),
            },
            &healthy_facts,
        );
        let approved = BTreeSet::from([preview.summaries[0].decision_key.clone()]);
        let mut unavailable_facts = facts();
        unavailable_facts.ai_config = None;

        let state = reconcile_with_facts(
            Some("workspace-1"),
            Some(Path::new("C:/repo")),
            "local-user",
            &definition_snapshot,
            ExternalSubagentDecisions {
                active_ecosystems: test_active_ecosystems(),
                approved_envelopes: &approved,
                declined_decisions: &empty_map,
                conflict_choices: &empty_map,
                conflict_lineage_current_keys: &empty_map,
                model_bindings: empty_model_bindings(),
            },
            &unavailable_facts,
        );

        assert_eq!(
            state.summaries[0].activation_state,
            ExternalSubagentActivationState::Unavailable
        );
        assert_eq!(
            state.summaries[0].compatibility_state,
            ExternalSubagentCompatibilityState::Ready
        );
        assert!(state.summaries[0].diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "external_subagent.configuration_unavailable"
                && diagnostic.blocks_activation
        }));
        assert!(!state.summaries[0]
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "external_subagent.model_unavailable"));
        assert!(state.pending_approvals.is_empty());
        assert!(state.registrations.is_empty());

        let recovered = reconcile_with_facts(
            Some("workspace-1"),
            Some(Path::new("C:/repo")),
            "local-user",
            &definition_snapshot,
            ExternalSubagentDecisions {
                active_ecosystems: test_active_ecosystems(),
                approved_envelopes: &approved,
                declined_decisions: &empty_map,
                conflict_choices: &empty_map,
                conflict_lineage_current_keys: &empty_map,
                model_bindings: empty_model_bindings(),
            },
            &healthy_facts,
        );
        assert_eq!(
            recovered.summaries[0].activation_state,
            ExternalSubagentActivationState::Active
        );
        assert_eq!(recovered.registrations.len(), 1);
    }

    #[test]
    fn unknown_source_tool_degrades_without_borrowing_a_same_named_host_tool() {
        let empty_set = BTreeSet::new();
        let empty_map = BTreeMap::new();
        let mut definition_snapshot = snapshot("behavior-v1", "catalog-v1");
        definition_snapshot.definitions[0].requested_tools.selectors[0] =
            ExternalSubagentToolSelector {
                source_name: "Read".to_string(),
                canonical_capability: None,
                allowed: true,
            };

        let state = reconcile_with_facts(
            Some("workspace-1"),
            Some(Path::new("C:/repo")),
            "local-user",
            &definition_snapshot,
            ExternalSubagentDecisions {
                active_ecosystems: test_active_ecosystems(),
                approved_envelopes: &empty_set,
                declined_decisions: &empty_map,
                conflict_choices: &empty_map,
                conflict_lineage_current_keys: &empty_map,
                model_bindings: empty_model_bindings(),
            },
            &facts(),
        );

        assert_eq!(state.summaries[0].unavailable_tool_labels, ["Read"]);
        assert_eq!(
            state.summaries[0].compatibility_state,
            ExternalSubagentCompatibilityState::ReadyWithDegradation
        );
        assert!(state.summaries[0].effective_tool_labels.is_empty());
        assert!(state.summaries[0].diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "external_subagent.tool_unavailable" && !diagnostic.blocks_activation
        }));
    }

    #[test]
    fn executable_and_file_mutation_capabilities_use_openbitfun_builtin_tools() {
        assert_eq!(
            host_tool_name(ExternalSubagentToolCapability::ExecuteCommand),
            "ExecCommand"
        );
        assert_eq!(
            host_tool_name(ExternalSubagentToolCapability::EditFile),
            "Edit"
        );
        assert_eq!(
            host_tool_name(ExternalSubagentToolCapability::WriteFile),
            "Write"
        );
    }

    #[test]
    fn model_config_outage_logging_is_deduplicated_and_does_not_expose_error_values() {
        let logged = AtomicBool::new(false);
        assert!(claim_model_config_outage_log(&logged));
        assert!(!claim_model_config_outage_log(&logged));
        logged.store(false, Ordering::Relaxed);
        assert!(claim_model_config_outage_log(&logged));

        let error = OpenBitFunError::config(
            "Failed to deserialize config value at 'ai': invalid value 'sk-sensitive'",
        );
        let category = model_config_error_category(&error);
        assert_eq!(category, "config_deserialization_failed");
        assert!(!category.contains("sk-sensitive"));
    }

    #[test]
    fn catalog_only_update_reuses_behavior_approval() {
        let first = snapshot("behavior-v1", "catalog-v1");
        let empty_set = BTreeSet::new();
        let empty_map = BTreeMap::new();
        let preview = reconcile_with_facts(
            Some("workspace-1"),
            Some(Path::new("C:/repo")),
            "local-user",
            &first,
            ExternalSubagentDecisions {
                active_ecosystems: test_active_ecosystems(),
                approved_envelopes: &empty_set,
                declined_decisions: &empty_map,
                conflict_choices: &empty_map,
                conflict_lineage_current_keys: &empty_map,
                model_bindings: empty_model_bindings(),
            },
            &facts(),
        );
        let approval = preview.summaries[0].decision_key.clone();
        let approved = BTreeSet::from([approval]);
        let updated = snapshot("behavior-v1", "catalog-v2");
        let state = reconcile_with_facts(
            Some("workspace-1"),
            Some(Path::new("C:/repo")),
            "local-user",
            &updated,
            ExternalSubagentDecisions {
                active_ecosystems: test_active_ecosystems(),
                approved_envelopes: &approved,
                declined_decisions: &empty_map,
                conflict_choices: &empty_map,
                conflict_lineage_current_keys: &empty_map,
                model_bindings: empty_model_bindings(),
            },
            &facts(),
        );
        assert_eq!(
            state.summaries[0].activation_state,
            ExternalSubagentActivationState::Active
        );
        assert_eq!(state.registrations.len(), 1);
        assert!(!state.registrations[0]
            .agent
            .description()
            .contains("catalog-v2"));
    }

    #[test]
    fn behavior_update_requires_a_new_approval() {
        let empty_set = BTreeSet::new();
        let empty_map = BTreeMap::new();
        let first = reconcile_with_facts(
            Some("workspace-1"),
            Some(Path::new("C:/repo")),
            "local-user",
            &snapshot("behavior-v1", "catalog-v1"),
            ExternalSubagentDecisions {
                active_ecosystems: test_active_ecosystems(),
                approved_envelopes: &empty_set,
                declined_decisions: &empty_map,
                conflict_choices: &empty_map,
                conflict_lineage_current_keys: &empty_map,
                model_bindings: empty_model_bindings(),
            },
            &facts(),
        );
        let approved = BTreeSet::from([first.summaries[0].decision_key.clone()]);
        let updated = reconcile_with_facts(
            Some("workspace-1"),
            Some(Path::new("C:/repo")),
            "local-user",
            &snapshot("behavior-v2", "catalog-v2"),
            ExternalSubagentDecisions {
                active_ecosystems: test_active_ecosystems(),
                approved_envelopes: &approved,
                declined_decisions: &empty_map,
                conflict_choices: &empty_map,
                conflict_lineage_current_keys: &empty_map,
                model_bindings: empty_model_bindings(),
            },
            &facts(),
        );
        assert_eq!(
            updated.summaries[0].activation_state,
            ExternalSubagentActivationState::ApprovalRequired
        );
        assert!(updated.registrations.is_empty());
    }

    #[test]
    fn permission_constraint_change_requires_new_approval_even_with_stale_provider_version() {
        let empty_set = BTreeSet::new();
        let empty_map = BTreeMap::new();
        let first = reconcile_with_facts(
            Some("workspace-1"),
            Some(Path::new("C:/repo")),
            "local-user",
            &snapshot("behavior-v1", "catalog-v1"),
            ExternalSubagentDecisions {
                active_ecosystems: test_active_ecosystems(),
                approved_envelopes: &empty_set,
                declined_decisions: &empty_map,
                conflict_choices: &empty_map,
                conflict_lineage_current_keys: &empty_map,
                model_bindings: empty_model_bindings(),
            },
            &facts(),
        );
        let approved = BTreeSet::from([first.summaries[0].decision_key.clone()]);
        let mut tightened_snapshot = snapshot("behavior-v1", "catalog-v1");
        tightened_snapshot.definitions[0].permission_constraints = PermissionConstraintLayer::new(
            vec![PermissionRule::new("edit", "*", PermissionEffect::Deny)],
        );

        let updated = reconcile_with_facts(
            Some("workspace-1"),
            Some(Path::new("C:/repo")),
            "local-user",
            &tightened_snapshot,
            ExternalSubagentDecisions {
                active_ecosystems: test_active_ecosystems(),
                approved_envelopes: &approved,
                declined_decisions: &empty_map,
                conflict_choices: &empty_map,
                conflict_lineage_current_keys: &empty_map,
                model_bindings: empty_model_bindings(),
            },
            &facts(),
        );

        assert_eq!(
            updated.summaries[0].activation_state,
            ExternalSubagentActivationState::ApprovalRequired
        );
        assert!(updated.registrations.is_empty());

        let reapproved = BTreeSet::from([updated.summaries[0].decision_key.clone()]);
        let activated = reconcile_with_facts(
            Some("workspace-1"),
            Some(Path::new("C:/repo")),
            "local-user",
            &tightened_snapshot,
            ExternalSubagentDecisions {
                active_ecosystems: test_active_ecosystems(),
                approved_envelopes: &reapproved,
                declined_decisions: &empty_map,
                conflict_choices: &empty_map,
                conflict_lineage_current_keys: &empty_map,
                model_bindings: empty_model_bindings(),
            },
            &facts(),
        );
        assert_eq!(activated.registrations.len(), 1);
        assert_eq!(
            activated.registrations[0]
                .agent
                .permission_constraints()
                .rules(),
            tightened_snapshot.definitions[0]
                .permission_constraints
                .rules()
        );
    }

    #[test]
    fn inherited_session_model_changes_do_not_invalidate_source_approval() {
        let empty_set = BTreeSet::new();
        let empty_map = BTreeMap::new();
        let first_facts = facts();
        let first = reconcile_with_facts(
            Some("workspace-1"),
            Some(Path::new("C:/repo")),
            "local-user",
            &snapshot("behavior-v1", "catalog-v1"),
            ExternalSubagentDecisions {
                active_ecosystems: test_active_ecosystems(),
                approved_envelopes: &empty_set,
                declined_decisions: &empty_map,
                conflict_choices: &empty_map,
                conflict_lineage_current_keys: &empty_map,
                model_bindings: empty_model_bindings(),
            },
            &first_facts,
        );
        let approved = BTreeSet::from([first.summaries[0].decision_key.clone()]);

        let mut updated_facts = facts();
        let updated_config = updated_facts.ai_config.as_mut().unwrap();
        updated_config.models = vec![active_model(
            "model_new",
            "New provider",
            "fake",
            "new-model",
        )];
        updated_config.default_models.fast = Some("model_new".to_string());
        let updated = reconcile_with_facts(
            Some("workspace-1"),
            Some(Path::new("C:/repo")),
            "local-user",
            &snapshot("behavior-v1", "catalog-v1"),
            ExternalSubagentDecisions {
                active_ecosystems: test_active_ecosystems(),
                approved_envelopes: &approved,
                declined_decisions: &empty_map,
                conflict_choices: &empty_map,
                conflict_lineage_current_keys: &empty_map,
                model_bindings: empty_model_bindings(),
            },
            &updated_facts,
        );

        assert_eq!(
            first.summaries[0].decision_key,
            updated.summaries[0].decision_key
        );
        assert_eq!(
            updated.summaries[0].activation_state,
            ExternalSubagentActivationState::Active
        );
        assert_eq!(updated.registrations.len(), 1);
        assert!(matches!(
            updated.registrations[0].model_binding,
            ExternalSubagentModelBinding::InheritParent
        ));
    }

    #[test]
    fn inherited_model_runtime_identity_changes_do_not_invalidate_source_approval() {
        let empty_set = BTreeSet::new();
        let empty_map = BTreeMap::new();
        let first_facts = facts();
        let first = reconcile_with_facts(
            Some("workspace-1"),
            Some(Path::new("C:/repo")),
            "local-user",
            &snapshot("behavior-v1", "catalog-v1"),
            ExternalSubagentDecisions {
                active_ecosystems: test_active_ecosystems(),
                approved_envelopes: &empty_set,
                declined_decisions: &empty_map,
                conflict_choices: &empty_map,
                conflict_lineage_current_keys: &empty_map,
                model_bindings: empty_model_bindings(),
            },
            &first_facts,
        );
        let approved = BTreeSet::from([first.summaries[0].decision_key.clone()]);

        let mut updated_facts = facts();
        let updated_config = updated_facts.ai_config.as_mut().unwrap();
        updated_config.models[0].provider = "other-provider".to_string();
        updated_config.models[0].model_name = "replacement-model".to_string();
        updated_config.models[0].base_url = "https://models.example/v2".to_string();
        let updated = reconcile_with_facts(
            Some("workspace-1"),
            Some(Path::new("C:/repo")),
            "local-user",
            &snapshot("behavior-v1", "catalog-v1"),
            ExternalSubagentDecisions {
                active_ecosystems: test_active_ecosystems(),
                approved_envelopes: &approved,
                declined_decisions: &empty_map,
                conflict_choices: &empty_map,
                conflict_lineage_current_keys: &empty_map,
                model_bindings: empty_model_bindings(),
            },
            &updated_facts,
        );

        assert_eq!(
            first.summaries[0].decision_key,
            updated.summaries[0].decision_key
        );
        assert_eq!(
            updated.summaries[0].activation_state,
            ExternalSubagentActivationState::Active
        );
        assert_eq!(updated.registrations.len(), 1);
        assert!(matches!(
            updated.registrations[0].model_binding,
            ExternalSubagentModelBinding::InheritParent
        ));
    }

    #[test]
    fn omitted_external_model_remains_inheritable_when_local_subagents_inherit() {
        let empty_set = BTreeSet::new();
        let empty_map = BTreeMap::new();
        let mut unavailable_facts = facts();
        unavailable_facts
            .ai_config
            .as_mut()
            .unwrap()
            .agent_model_defaults
            .subagents
            .default_selection = SubagentModelSelection::Inherit;

        let state = reconcile_with_facts(
            Some("workspace-1"),
            Some(Path::new("C:/repo")),
            "local-user",
            &snapshot("behavior-v1", "catalog-v1"),
            ExternalSubagentDecisions {
                active_ecosystems: test_active_ecosystems(),
                approved_envelopes: &empty_set,
                declined_decisions: &empty_map,
                conflict_choices: &empty_map,
                conflict_lineage_current_keys: &empty_map,
                model_bindings: empty_model_bindings(),
            },
            &unavailable_facts,
        );

        assert_eq!(
            state.summaries[0].activation_state,
            ExternalSubagentActivationState::ApprovalRequired
        );
        assert_eq!(state.summaries[0].effective_model_label, None);
        assert!(state.registrations.is_empty(), "approval is still required");
    }

    #[test]
    fn unresolved_conflict_is_fail_closed_and_atomic_choice_can_activate() {
        let mut facts = facts();
        facts.locals.insert(
            "reviewer".to_string(),
            LocalCandidateFact {
                logical_id: "reviewer".to_string(),
                candidate_id: "local_subagent:reviewer".to_string(),
                display_name: "Local reviewer".to_string(),
                source_label: "OpenBitFun project".to_string(),
                behavior_version: "local-v1".to_string(),
            },
        );
        let empty_set = BTreeSet::new();
        let empty_map = BTreeMap::new();
        let preview = reconcile_with_facts(
            Some("workspace-1"),
            Some(Path::new("C:/repo")),
            "local-user",
            &snapshot("behavior-v1", "catalog-v1"),
            ExternalSubagentDecisions {
                active_ecosystems: test_active_ecosystems(),
                approved_envelopes: &empty_set,
                declined_decisions: &empty_map,
                conflict_choices: &empty_map,
                conflict_lineage_current_keys: &empty_map,
                model_bindings: empty_model_bindings(),
            },
            &facts,
        );
        assert_eq!(
            preview.routes.get("reviewer"),
            Some(&ExternalSubagentRoute::Unavailable)
        );
        assert_eq!(preview.conflicts[0].candidates.len(), 2);
        assert!(
            !preview.conflicts[0].candidates[0].external,
            "the OpenBitFun/local candidate must be shown before external candidates"
        );
        let external_id = preview.conflicts[0]
            .candidates
            .iter()
            .find(|candidate| candidate.external)
            .unwrap()
            .candidate_id
            .clone();
        let approval = preview.summaries[0].decision_key.clone();
        let choices = BTreeMap::from([(preview.conflicts[0].conflict_key.clone(), external_id)]);
        let approved = BTreeSet::from([approval]);
        let active = reconcile_with_facts(
            Some("workspace-1"),
            Some(Path::new("C:/repo")),
            "local-user",
            &snapshot("behavior-v1", "catalog-v1"),
            ExternalSubagentDecisions {
                active_ecosystems: test_active_ecosystems(),
                approved_envelopes: &approved,
                declined_decisions: &empty_map,
                conflict_choices: &choices,
                conflict_lineage_current_keys: &preview.observed_conflict_lineage_current_keys,
                model_bindings: empty_model_bindings(),
            },
            &facts,
        );
        assert!(matches!(
            active.routes.get("reviewer"),
            Some(ExternalSubagentRoute::External(_))
        ));
    }

    #[test]
    fn model_config_outage_preserves_conflict_choice_for_recovery() {
        for select_external in [false, true] {
            let (preview, mut product_facts) = conflict_preview_with_local();
            let conflict = &preview.conflicts[0];
            let external_id = conflict
                .candidates
                .iter()
                .find(|candidate| candidate.external)
                .unwrap()
                .candidate_id
                .clone();
            let selected_id = if select_external {
                external_id
            } else {
                "local_subagent:reviewer".to_string()
            };
            let choices = BTreeMap::from([(conflict.conflict_key.clone(), selected_id.clone())]);
            let approved = BTreeSet::from([preview.summaries[0].decision_key.clone()]);
            let empty_map = BTreeMap::new();
            let healthy_ai_config = product_facts.ai_config.take();

            let unavailable = reconcile_with_facts(
                Some("workspace-1"),
                Some(Path::new("C:/repo")),
                "local-user",
                &snapshot("behavior-v1", "catalog-v1"),
                ExternalSubagentDecisions {
                    active_ecosystems: test_active_ecosystems(),
                    approved_envelopes: &approved,
                    declined_decisions: &empty_map,
                    conflict_choices: &choices,
                    conflict_lineage_current_keys: &preview.observed_conflict_lineage_current_keys,
                    model_bindings: empty_model_bindings(),
                },
                &product_facts,
            );

            assert_eq!(
                unavailable.routes.get("reviewer"),
                Some(&ExternalSubagentRoute::Unavailable)
            );
            assert!(unavailable
                .summaries
                .iter()
                .all(|summary| summary.activation_state
                    == ExternalSubagentActivationState::Unavailable));
            assert!(unavailable.conflicts.is_empty());
            assert!(unavailable
                .observed_conflict_lineage_current_keys
                .is_empty());
            assert!(unavailable.pending_approvals.is_empty());
            assert!(unavailable.registrations.is_empty());

            product_facts.ai_config = healthy_ai_config;
            let recovered = reconcile_with_facts(
                Some("workspace-1"),
                Some(Path::new("C:/repo")),
                "local-user",
                &snapshot("behavior-v1", "catalog-v1"),
                ExternalSubagentDecisions {
                    active_ecosystems: test_active_ecosystems(),
                    approved_envelopes: &approved,
                    declined_decisions: &empty_map,
                    conflict_choices: &choices,
                    conflict_lineage_current_keys: &preview.observed_conflict_lineage_current_keys,
                    model_bindings: empty_model_bindings(),
                },
                &product_facts,
            );

            assert_eq!(
                recovered.conflicts[0].selected_candidate_id.as_deref(),
                Some(selected_id.as_str())
            );
            assert_eq!(
                recovered.observed_conflict_lineage_current_keys,
                preview.observed_conflict_lineage_current_keys
            );
            if select_external {
                assert!(matches!(
                    recovered.routes.get("reviewer"),
                    Some(ExternalSubagentRoute::External(_))
                ));
                assert_eq!(recovered.registrations.len(), 1);
            } else {
                assert_eq!(
                    recovered.routes.get("reviewer"),
                    Some(&ExternalSubagentRoute::Local)
                );
                assert!(recovered.registrations.is_empty());
            }
        }
    }

    fn conflict_preview_with_local() -> (ExternalSubagentProductState, ProductFacts) {
        let mut product_facts = facts();
        product_facts.locals.insert(
            "reviewer".to_string(),
            LocalCandidateFact {
                logical_id: "reviewer".to_string(),
                candidate_id: "local_subagent:reviewer".to_string(),
                display_name: "Local reviewer".to_string(),
                source_label: "OpenBitFun project".to_string(),
                behavior_version: "local-v1".to_string(),
            },
        );
        let empty_set = BTreeSet::new();
        let empty_map = BTreeMap::new();
        let preview = reconcile_with_facts(
            Some("workspace-1"),
            Some(Path::new("C:/repo")),
            "local-user",
            &snapshot("behavior-v1", "catalog-v1"),
            ExternalSubagentDecisions {
                active_ecosystems: test_active_ecosystems(),
                approved_envelopes: &empty_set,
                declined_decisions: &empty_map,
                conflict_choices: &empty_map,
                conflict_lineage_current_keys: &empty_map,
                model_bindings: empty_model_bindings(),
            },
            &product_facts,
        );
        (preview, product_facts)
    }

    #[test]
    fn selected_local_does_not_switch_to_external_when_local_participant_disappears() {
        let (preview, _facts_with_local) = conflict_preview_with_local();
        let conflict = &preview.conflicts[0];
        let choices = BTreeMap::from([(
            conflict.conflict_key.clone(),
            "local_subagent:reviewer".to_string(),
        )]);
        let empty_set = BTreeSet::new();
        let empty_map = BTreeMap::new();

        let shrunk = reconcile_with_facts(
            Some("workspace-1"),
            Some(Path::new("C:/repo")),
            "local-user",
            &snapshot("behavior-v1", "catalog-v1"),
            ExternalSubagentDecisions {
                active_ecosystems: test_active_ecosystems(),
                approved_envelopes: &empty_set,
                declined_decisions: &empty_map,
                conflict_choices: &choices,
                conflict_lineage_current_keys: &preview.observed_conflict_lineage_current_keys,
                model_bindings: empty_model_bindings(),
            },
            &facts(),
        );

        assert_eq!(
            shrunk.routes.get("reviewer"),
            Some(&ExternalSubagentRoute::Unavailable)
        );
        assert_eq!(shrunk.conflicts[0].candidates.len(), 1);
        assert!(shrunk.conflicts[0].selected_candidate_id.is_none());
    }

    #[test]
    fn selected_external_does_not_switch_to_local_when_external_participant_disappears() {
        let (preview, facts_with_local) = conflict_preview_with_local();
        let conflict = &preview.conflicts[0];
        let external_id = conflict
            .candidates
            .iter()
            .find(|candidate| candidate.external)
            .unwrap()
            .candidate_id
            .clone();
        let choices = BTreeMap::from([(conflict.conflict_key.clone(), external_id)]);
        let empty_set = BTreeSet::new();
        let empty_map = BTreeMap::new();
        let mut without_external = snapshot("behavior-v1", "catalog-v1");
        without_external.definitions.clear();

        let shrunk = reconcile_with_facts(
            Some("workspace-1"),
            Some(Path::new("C:/repo")),
            "local-user",
            &without_external,
            ExternalSubagentDecisions {
                active_ecosystems: test_active_ecosystems(),
                approved_envelopes: &empty_set,
                declined_decisions: &empty_map,
                conflict_choices: &choices,
                conflict_lineage_current_keys: &preview.observed_conflict_lineage_current_keys,
                model_bindings: empty_model_bindings(),
            },
            &facts_with_local,
        );

        assert_eq!(
            shrunk.routes.get("reviewer"),
            Some(&ExternalSubagentRoute::Unavailable)
        );
        assert_eq!(shrunk.conflicts[0].candidates.len(), 1);
        assert!(shrunk.conflicts[0].selected_candidate_id.is_none());
    }

    #[test]
    fn keep_unavailable_survives_participant_set_shrink() {
        let (preview, facts_with_local) = conflict_preview_with_local();
        let choices = BTreeMap::from([(
            preview.conflicts[0].conflict_key.clone(),
            DISABLED_SUBAGENT_CONFLICT_CHOICE.to_string(),
        )]);
        let empty_set = BTreeSet::new();
        let empty_map = BTreeMap::new();
        let mut without_external = snapshot("behavior-v1", "catalog-v1");
        without_external.definitions.clear();

        let shrunk = reconcile_with_facts(
            Some("workspace-1"),
            Some(Path::new("C:/repo")),
            "local-user",
            &without_external,
            ExternalSubagentDecisions {
                active_ecosystems: test_active_ecosystems(),
                approved_envelopes: &empty_set,
                declined_decisions: &empty_map,
                conflict_choices: &choices,
                conflict_lineage_current_keys: &preview.observed_conflict_lineage_current_keys,
                model_bindings: empty_model_bindings(),
            },
            &facts_with_local,
        );

        assert_eq!(
            shrunk.routes.get("reviewer"),
            Some(&ExternalSubagentRoute::Unavailable)
        );
        assert!(shrunk.conflicts[0].selected_candidate_id.is_none());
    }
}
