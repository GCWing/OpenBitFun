//! Thin orchestration for explicitly copying external MCP declarations into
//! the existing native user configuration owner.

use openbitfun_product_domains::external_sources::{
    EcosystemId, ExternalMcpImportApplyOutcomeV1, ExternalMcpImportApplyRequestV1,
    ExternalMcpImportApplyResultV1, ExternalMcpImportDispositionV1, ExternalMcpImportPlanItemV1,
    ExternalMcpImportPlanV1, ExternalMcpImportedItemV1, ExternalMcpServerDefinition,
    ExternalSourceOperationError, ExternalSourceOperationErrorCode, ExternalSourceOperationResult,
    PreparedExternalMcpImportServer, PreparedExternalMcpImportTransport,
    EXTERNAL_MCP_IMPORT_SCHEMA_V1,
};
use openbitfun_services_integrations::mcp::config::{
    MCPImportError, MCPImportServer, MCPImportTransport, MCPUserImportSnapshot,
};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ExternalMcpImportPreparation {
    Prepared(PreparedExternalMcpImportServer),
    Unavailable(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ExternalMcpImportCandidate {
    pub definition: ExternalMcpServerDefinition,
    pub ecosystem_id: EcosystemId,
    pub preparation: ExternalMcpImportPreparation,
}

struct ComputedPlan {
    source_ids: BTreeMap<String, String>,
    public: ExternalMcpImportPlanV1,
    target_fingerprint: String,
    target_native_ids: BTreeSet<String>,
    prepared: BTreeMap<String, PreparedExternalMcpImportServer>,
}

const MAX_IMPORT_PLAN_ITEMS: usize = 256;
const MAX_NATIVE_ID_BYTES: usize = 160;

pub async fn plan_external_mcp_import(
    workspace_id: Option<String>,
) -> ExternalSourceOperationResult<ExternalMcpImportPlanV1> {
    let config_service = mcp_config_service().await?;
    Ok(compute_current_plan(workspace_id, &config_service)
        .await?
        .public)
}

pub async fn apply_external_mcp_import(
    workspace_id: Option<String>,
    request: ExternalMcpImportApplyRequestV1,
) -> ExternalSourceOperationResult<ExternalMcpImportApplyResultV1> {
    request.validate().map_err(|_| {
        operation_error(
            ExternalSourceOperationErrorCode::InvalidRequest,
            "The MCP import request is invalid",
            false,
        )
    })?;
    let config_service = mcp_config_service().await?;
    let computed = compute_current_plan(workspace_id.clone(), &config_service).await?;
    if request.plan_fingerprint != computed.public.plan_fingerprint {
        return Ok(stale_result(computed.public));
    }
    let imports = match selected_imports(&computed, &request) {
        Ok(imports) => imports,
        Err(SelectionError::Stale) => return Ok(stale_result(computed.public)),
        Err(SelectionError::Invalid) => {
            return Err(operation_error(
                ExternalSourceOperationErrorCode::InvalidRequest,
                "The requested MCP native id is invalid",
                false,
            ));
        }
    };
    let imported = imports
        .iter()
        .map(|import| ExternalMcpImportedItemV1 {
            candidate_id: import.candidate_id.clone(),
            native_id: import.native_id.clone(),
        })
        .collect();
    match config_service
        .apply_user_import(&computed.target_fingerprint, imports)
        .await
    {
        Ok(()) => Ok(ExternalMcpImportApplyResultV1 {
            schema_version: EXTERNAL_MCP_IMPORT_SCHEMA_V1,
            outcome: ExternalMcpImportApplyOutcomeV1::Applied { imported },
        }),
        Err(MCPImportError::StaleConfiguration | MCPImportError::TargetConflict { .. }) => {
            let refreshed = compute_current_plan(workspace_id, &config_service).await?;
            Ok(stale_result(refreshed.public))
        }
        Err(error) => Err(map_import_error(error)),
    }
}

async fn mcp_config_service(
) -> ExternalSourceOperationResult<crate::service::mcp::config::MCPConfigService> {
    let config_service = crate::service::config::get_global_config_service()
        .await
        .map_err(|_| {
            operation_error(
                ExternalSourceOperationErrorCode::Unavailable,
                "The MCP configuration service is unavailable",
                true,
            )
        })?;
    crate::service::mcp::config::MCPConfigService::new(config_service).map_err(|_| {
        operation_error(
            ExternalSourceOperationErrorCode::Unavailable,
            "The MCP configuration service is unavailable",
            true,
        )
    })
}

async fn compute_current_plan(
    workspace_id: Option<String>,
    config_service: &crate::service::mcp::config::MCPConfigService,
) -> ExternalSourceOperationResult<ComputedPlan> {
    let workspace_id = ensure_local_workspace(workspace_id).await?;
    let candidates =
        crate::external_sources::collect_external_mcp_import_candidates(workspace_id.as_deref())
            .await
            .map_err(|_| {
                operation_error(
                    ExternalSourceOperationErrorCode::Unavailable,
                    "External MCP sources could not be refreshed",
                    true,
                )
            })?;
    if candidates.len() > MAX_IMPORT_PLAN_ITEMS {
        return Err(operation_error(
            ExternalSourceOperationErrorCode::Unsupported,
            "External MCP import has too many candidates to review safely",
            false,
        ));
    }
    let target = config_service
        .user_import_snapshot()
        .await
        .map_err(map_import_error)?;
    Ok(build_import_plan(&target, candidates))
}

async fn ensure_local_workspace(
    workspace_id: Option<String>,
) -> ExternalSourceOperationResult<Option<String>> {
    if let Some(id) = workspace_id.as_deref() {
        let service =
            crate::service::workspace::get_global_workspace_service().ok_or_else(|| {
                operation_error(
                    ExternalSourceOperationErrorCode::Unavailable,
                    "Workspace service is unavailable",
                    true,
                )
            })?;
        let workspace = service.require_workspace(id).await.map_err(|_| {
            operation_error(
                ExternalSourceOperationErrorCode::InvalidRequest,
                "Unknown workspace ID",
                false,
            )
        })?;
        if workspace.workspace_kind == crate::service::workspace::WorkspaceKind::Remote {
            return Err(operation_error(
                ExternalSourceOperationErrorCode::Unsupported,
                "External MCP import is not available for a remote workspace",
                false,
            ));
        }
    }
    Ok(workspace_id)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SelectionError {
    Stale,
    Invalid,
}

fn selected_imports(
    current: &ComputedPlan,
    request: &ExternalMcpImportApplyRequestV1,
) -> Result<Vec<MCPImportServer>, SelectionError> {
    let items = current
        .public
        .items
        .iter()
        .map(|item| (item.candidate_id.as_str(), item))
        .collect::<BTreeMap<_, _>>();
    let mut native_ids = BTreeSet::new();
    let mut imports = Vec::with_capacity(request.selections.len());
    for selection in &request.selections {
        let item = items
            .get(selection.candidate_id.as_str())
            .ok_or(SelectionError::Stale)?;
        if !matches!(
            item.disposition,
            ExternalMcpImportDispositionV1::Eligible
                | ExternalMcpImportDispositionV1::AutomaticRename
        ) {
            return Err(SelectionError::Stale);
        }
        let native_id = selection
            .requested_native_id
            .clone()
            .or_else(|| item.proposed_native_id.clone())
            .ok_or(SelectionError::Stale)?;
        if !valid_native_id(&native_id) {
            return Err(SelectionError::Invalid);
        }
        if current.target_native_ids.contains(&native_id) || !native_ids.insert(native_id.clone()) {
            return Err(SelectionError::Invalid);
        }
        let prepared = current
            .prepared
            .get(&selection.candidate_id)
            .ok_or(SelectionError::Stale)?;
        imports.push(MCPImportServer {
            environment: prepared.environment.clone(),
            headers: prepared.headers.clone(),
            source_id: current.source_ids.get(&selection.candidate_id).cloned(),
            working_directory: prepared
                .working_directory
                .as_ref()
                .map(|path| path.to_string_lossy().into_owned()),
            timeouts: openbitfun_services_integrations::mcp::MCPServerTimeouts {
                startup_ms: prepared.timeouts.startup_ms,
                catalog_ms: prepared.timeouts.catalog_ms,
                execution_ms: prepared.timeouts.execution_ms,
            },
            oauth_enabled: prepared.oauth_enabled,
            native_id,
            candidate_id: selection.candidate_id.clone(),
            behavior_version: prepared.behavior_version.clone(),
            display_name: item.display_name.clone(),
            transport: match &prepared.transport {
                PreparedExternalMcpImportTransport::Local { command, args } => {
                    MCPImportTransport::Local {
                        command: command.clone(),
                        args: args.clone(),
                    }
                }
                PreparedExternalMcpImportTransport::Remote { url } => {
                    MCPImportTransport::Remote { url: url.clone() }
                }
            },
        });
    }
    Ok(imports)
}

fn build_import_plan(
    target: &MCPUserImportSnapshot,
    mut candidates: Vec<ExternalMcpImportCandidate>,
) -> ComputedPlan {
    let source_ids = candidates
        .iter()
        .map(|candidate| {
            (
                candidate.definition.candidate_id(),
                candidate.ecosystem_id.as_str().to_string(),
            )
        })
        .collect();
    candidates.sort_by(|left, right| left.definition.id.cmp(&right.definition.id));
    let mut reserved = target.native_ids.clone();
    let mut prepared = BTreeMap::new();
    let mut items = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        let candidate_id = candidate.definition.candidate_id();
        let already_imported = target.imports.iter().any(|import| {
            import.candidate_id == candidate_id
                && import.behavior_version == candidate.definition.behavior_version
        });
        let (proposed_native_id, disposition, reason_code) = if already_imported {
            (None, ExternalMcpImportDispositionV1::AlreadyImported, None)
        } else {
            match candidate.preparation {
                ExternalMcpImportPreparation::Unavailable(reason) => (
                    None,
                    ExternalMcpImportDispositionV1::Unavailable,
                    Some(bounded_reason_code(&reason)),
                ),
                ExternalMcpImportPreparation::Prepared(value) => {
                    let (native_id, renamed) = reserve_native_id(
                        &candidate.definition.name,
                        candidate.ecosystem_id.as_str(),
                        &mut reserved,
                    );
                    prepared.insert(candidate_id.clone(), value);
                    (
                        Some(native_id),
                        if renamed {
                            ExternalMcpImportDispositionV1::AutomaticRename
                        } else {
                            ExternalMcpImportDispositionV1::Eligible
                        },
                        None,
                    )
                }
            }
        };
        items.push(ExternalMcpImportPlanItemV1 {
            candidate_id,
            display_name: candidate.definition.name,
            transport: candidate.definition.transport,
            proposed_native_id,
            disposition,
            reason_code,
        });
    }
    let mut public = ExternalMcpImportPlanV1 {
        schema_version: EXTERNAL_MCP_IMPORT_SCHEMA_V1,
        plan_fingerprint: String::new(),
        items,
    };
    public.plan_fingerprint = plan_fingerprint(target, &public, &prepared);
    ComputedPlan {
        source_ids,
        public,
        target_fingerprint: target.fingerprint.clone(),
        target_native_ids: target.native_ids.clone(),
        prepared,
    }
}

fn reserve_native_id(
    raw_base: &str,
    ecosystem: &str,
    reserved: &mut BTreeSet<String>,
) -> (String, bool) {
    let base = bounded_native_id(raw_base);
    let normalized = base != raw_base;
    if reserved.insert(base.clone()) {
        return (base, normalized);
    }
    let suffix = native_id_suffix(ecosystem);
    for index in 1_u32.. {
        let tail = if index == 1 {
            suffix.clone()
        } else {
            format!("{suffix}-{index}")
        };
        let candidate = bounded_renamed_id(&base, &tail);
        if reserved.insert(candidate.clone()) {
            return (candidate, true);
        }
    }
    unreachable!("native id suffix space cannot be exhausted")
}

fn bounded_native_id(value: &str) -> String {
    if value.len() <= MAX_NATIVE_ID_BYTES {
        return value.to_string();
    }
    let digest = hex::encode(Sha256::digest(value.as_bytes()));
    let tail = format!("-{}", &digest[..12]);
    format!(
        "{}{}",
        truncate_utf8(value, MAX_NATIVE_ID_BYTES - tail.len()),
        tail
    )
}

fn bounded_renamed_id(base: &str, suffix: &str) -> String {
    let full = format!("{base}-{suffix}");
    if full.len() <= MAX_NATIVE_ID_BYTES {
        return full;
    }
    let digest = hex::encode(Sha256::digest(full.as_bytes()));
    let tail = format!("-{}-{}", truncate_utf8(suffix, 24), &digest[..12]);
    format!(
        "{}{}",
        truncate_utf8(base, MAX_NATIVE_ID_BYTES - tail.len()),
        tail
    )
}

fn truncate_utf8(value: &str, max_bytes: usize) -> &str {
    let mut end = value.len().min(max_bytes);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}

fn native_id_suffix(ecosystem: &str) -> String {
    let value = ecosystem
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>();
    let value = value
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if value.is_empty() {
        "external".to_string()
    } else {
        value
    }
}

fn bounded_reason_code(value: &str) -> String {
    if value.is_empty() || value.len() > 160 || value.chars().any(char::is_control) {
        "external_mcp.import_unavailable".to_string()
    } else {
        value.to_string()
    }
}

fn valid_native_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_NATIVE_ID_BYTES
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

fn plan_fingerprint(
    target: &MCPUserImportSnapshot,
    plan: &ExternalMcpImportPlanV1,
    prepared: &BTreeMap<String, PreparedExternalMcpImportServer>,
) -> String {
    let mut facts = plan.clone();
    facts.plan_fingerprint.clear();
    let mut hasher = Sha256::new();
    hash_part(&mut hasher, target.fingerprint.as_bytes());
    hash_part(
        &mut hasher,
        &serde_json::to_vec(&facts).expect("MCP import plan serialization cannot fail"),
    );
    for (candidate_id, server) in prepared {
        hash_part(
            &mut hasher,
            &serde_json::to_vec(&(
                &server.working_directory,
                &server.environment,
                &server.headers,
                server.timeouts,
                server.oauth_enabled,
            ))
            .expect("MCP import options serialization cannot fail"),
        );
        hash_part(&mut hasher, candidate_id.as_bytes());
        hash_part(&mut hasher, server.behavior_version.as_bytes());
        match &server.transport {
            PreparedExternalMcpImportTransport::Local { command, args } => {
                hash_part(&mut hasher, command.as_bytes());
                for argument in args {
                    hash_part(&mut hasher, argument.as_bytes());
                }
            }
            PreparedExternalMcpImportTransport::Remote { url } => {
                hash_part(&mut hasher, url.as_bytes());
            }
        }
    }
    format!("sha256:{}", hex::encode(hasher.finalize()))
}

fn hash_part(hasher: &mut Sha256, value: &[u8]) {
    hasher.update((value.len() as u64).to_le_bytes());
    hasher.update(value);
}

fn stale_result(plan: ExternalMcpImportPlanV1) -> ExternalMcpImportApplyResultV1 {
    ExternalMcpImportApplyResultV1 {
        schema_version: EXTERNAL_MCP_IMPORT_SCHEMA_V1,
        outcome: ExternalMcpImportApplyOutcomeV1::Stale {
            refreshed_plan: plan,
        },
    }
}

fn map_import_error(error: MCPImportError) -> ExternalSourceOperationError {
    match error {
        MCPImportError::InvalidRequest(_) => operation_error(
            ExternalSourceOperationErrorCode::InvalidRequest,
            "The MCP import request is invalid",
            false,
        ),
        MCPImportError::UnsupportedTargetFormat => operation_error(
            ExternalSourceOperationErrorCode::Unsupported,
            "The user MCP configuration format cannot be updated safely",
            false,
        ),
        MCPImportError::StaleConfiguration => operation_error(
            ExternalSourceOperationErrorCode::StaleRevision,
            "The user MCP configuration changed; refresh and retry",
            true,
        ),
        MCPImportError::TargetConflict { .. } => operation_error(
            ExternalSourceOperationErrorCode::Conflict,
            "An MCP native id became unavailable; refresh and retry",
            true,
        ),
        MCPImportError::Store(_) => operation_error(
            ExternalSourceOperationErrorCode::Internal,
            "The user MCP configuration could not be updated",
            true,
        ),
    }
}

fn operation_error(
    code: ExternalSourceOperationErrorCode,
    detail: &'static str,
    retryable: bool,
) -> ExternalSourceOperationError {
    ExternalSourceOperationError::new(code, detail, retryable).with_default_recovery_actions()
}

#[cfg(test)]
mod tests {
    use super::*;
    use openbitfun_product_domains::external_sources::{
        ExternalMcpStaticStatus, ExternalMcpTransportKind, SourceKey, SourceQualifiedMcpServerId,
    };

    fn candidate(command: &str) -> ExternalMcpImportCandidate {
        let source = SourceKey::new("opencode.mcp", "user-config").unwrap();
        let id = SourceQualifiedMcpServerId::new(source.clone(), "docs").unwrap();
        ExternalMcpImportCandidate {
            definition: ExternalMcpServerDefinition {
                id: id.clone(),
                provenance: vec![source],
                name: "docs".to_string(),
                transport: ExternalMcpTransportKind::LocalStdio,
                command_preview: Some("docs-mcp".to_string()),
                argument_count: 0,
                working_directory: None,
                environment_keys: Vec::new(),
                environment_reference_names: Vec::new(),
                remote_url_preview: None,
                header_names: Vec::new(),
                timeouts: Default::default(),
                source_enabled: true,
                behavior_version: "sha256:behavior-v1".to_string(),
                static_status: ExternalMcpStaticStatus::Ready,
            },
            ecosystem_id: EcosystemId::new("opencode").unwrap(),
            preparation: ExternalMcpImportPreparation::Prepared(PreparedExternalMcpImportServer {
                environment: Default::default(),
                headers: Default::default(),
                working_directory: None,
                timeouts: Default::default(),
                oauth_enabled: None,
                id,
                behavior_version: "sha256:behavior-v1".to_string(),
                transport: PreparedExternalMcpImportTransport::Local {
                    command: command.to_string(),
                    args: Vec::new(),
                },
            }),
        }
    }

    fn target(ids: &[&str]) -> MCPUserImportSnapshot {
        MCPUserImportSnapshot {
            fingerprint: "sha256:target".to_string(),
            native_ids: ids.iter().map(|id| (*id).to_string()).collect(),
            imports: Vec::new(),
        }
    }

    #[test]
    fn import_eligibility_uses_preparation_instead_of_external_runtime_status() {
        for status in [
            ExternalMcpStaticStatus::DisabledBySource,
            ExternalMcpStaticStatus::Unsupported {
                reason: "External lifecycle is not implemented".into(),
            },
        ] {
            let mut value = candidate("docs");
            value.definition.source_enabled = false;
            value.definition.static_status = status;
            let plan = build_import_plan(&target(&[]), vec![value]);
            assert_eq!(
                plan.public.items[0].disposition,
                ExternalMcpImportDispositionV1::Eligible
            );
        }
    }

    #[test]
    fn plan_renames_conflicts_without_exposing_private_preparation() {
        let plan = build_import_plan(&target(&["docs"]), vec![candidate("private-command")]);
        assert_eq!(
            plan.public.items[0].disposition,
            ExternalMcpImportDispositionV1::AutomaticRename
        );
        assert_eq!(
            plan.public.items[0].proposed_native_id.as_deref(),
            Some("docs-opencode")
        );
        let encoded = serde_json::to_string(&plan.public).unwrap();
        assert!(!encoded.contains("private-command"));
    }

    #[test]
    fn private_projection_changes_invalidate_the_public_plan_fingerprint() {
        let first = build_import_plan(&target(&[]), vec![candidate("command-a")]);
        let second = build_import_plan(&target(&[]), vec![candidate("command-b")]);
        assert_ne!(
            first.public.plan_fingerprint,
            second.public.plan_fingerprint
        );
    }

    #[test]
    fn import_options_are_versioned_and_forwarded_to_the_config_owner() {
        let baseline = build_import_plan(&target(&[]), vec![candidate("node")]);
        let mut changed = candidate("node");
        let cwd = std::env::current_dir().unwrap();
        if let ExternalMcpImportPreparation::Prepared(server) = &mut changed.preparation {
            server.working_directory = Some(cwd.clone());
            server.timeouts.execution_ms = Some(60_000);
        }
        let plan = build_import_plan(&target(&[]), vec![changed]);
        assert_ne!(
            baseline.public.plan_fingerprint,
            plan.public.plan_fingerprint
        );
        let request = ExternalMcpImportApplyRequestV1 {
            schema_version: EXTERNAL_MCP_IMPORT_SCHEMA_V1,
            plan_fingerprint: plan.public.plan_fingerprint.clone(),
            selections: vec![
                openbitfun_product_domains::external_sources::ExternalMcpImportSelectionV1 {
                    candidate_id: plan.public.items[0].candidate_id.clone(),
                    requested_native_id: None,
                },
            ],
        };
        let imports = selected_imports(&plan, &request).unwrap();
        assert_eq!(imports[0].working_directory.as_deref(), cwd.to_str());
        assert_eq!(imports[0].timeouts.execution_ms, Some(60_000));
    }

    #[test]
    fn long_source_names_are_bounded_and_reported_as_automatic_renames() {
        let (native_id, renamed) =
            reserve_native_id(&"文".repeat(200), "opencode", &mut BTreeSet::new());
        assert!(renamed);
        assert!(native_id.len() <= MAX_NATIVE_ID_BYTES);
        assert!(valid_native_id(&native_id));
    }
}
