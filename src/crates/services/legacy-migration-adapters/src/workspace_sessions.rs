use super::common::{
    backup_domain_dir, backup_file_once, io_error, read_bounded_json, read_optional_bounded_json,
    relative_display, restore_unverified_file, stage_domain_dir, validate_regular_file,
};
use openbitfun_core_types::product_identity::product_id;
use openbitfun_core_types::validate_session_id;
use openbitfun_legacy_migration::copy_directory as copy_tree;
use openbitfun_legacy_migration::{
    atomic_write_bytes, atomic_write_json, DomainContext, DomainScan, LegacyDomainAdapter,
    LegacyMigrationError, LegacyMigrationResult, MigrationRoots,
};
use openbitfun_product_domains::legacy_migration::{
    ConflictResolution, FindingSeverity, MigrationConflict, MigrationDiagnostic, MigrationDomainId,
    MigrationDomainResult, MigrationDomainState, ScanFinding,
};
use openbitfun_services_core::session::{
    OfflineSessionBundle, OfflineSessionImportStore, SessionMetadata, SessionRelationship,
    StoredDialogTurnFile, StoredSessionMetadataFile, SESSION_STORAGE_SCHEMA_VERSION,
};
use openbitfun_services_core::session_projection_format::validate_runtime_event_log;
use openbitfun_services_core::workspace_identity::build_project_runtime_slug;
use openbitfun_services_core::workspace_identity::{
    canonicalize_local_workspace_root, local_workspace_stable_storage_id,
    normalize_remote_workspace_path, remote_workspace_stable_id, LOCAL_WORKSPACE_SSH_HOST,
};
use openbitfun_services_core::workspace_persistence::{
    unsupported_workspace_persistence, validate_workspace_persistence_data,
    WorkspacePersistenceData, WORKSPACE_PERSISTENCE_FORMAT_VERSION,
};
use openbitfun_services_core::workspace_records::{
    PrimaryAssistantKey, WorkspaceInfo, WorkspaceKind,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};

const MAX_SESSION_FILES: usize = 4096;
const MAX_SESSION_FILE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_SESSION_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_RUNTIME_EVENT_BYTES: u64 = 256 * 1024 * 1024;
const MAX_RUNTIME_DIRECTORIES: usize = 32_768;
const MAX_RUNTIME_DEPTH: usize = 16;

const SESSION_ROOT_FILES: &[&str] = &[
    "state.json",
    "turn-catalog.json",
    "token-anchors.json",
    "session-revert.json",
    "evidence-ledger.json",
];
const SESSION_REBUILDABLE_ROOT_FILES: &[&str] = &["prompt_cache.json"];
const SESSION_OWNED_DIRECTORIES: &[&str] = &["snapshots", "artifacts", "tool-results"];

pub(crate) struct WorkspaceSessionsAdapter;

#[derive(Debug, Clone, Default, Serialize)]
pub struct MigrationItemCounts {
    pub imported: u64,
    pub skipped: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceReportCounts {
    pub sessions: MigrationItemCounts,
    pub workspaces: MigrationItemCounts,
    pub assistant_directories: MigrationItemCounts,
}

/// Project both old and new run manifests into user-facing entity counts.
/// Auxiliary exclusions remain in the original manifest, not in these totals.
pub fn workspace_report_counts(
    roots: &MigrationRoots,
    report: &openbitfun_product_domains::legacy_migration::MigrationRunReport,
) -> LegacyMigrationResult<WorkspaceReportCounts> {
    uuid::Uuid::parse_str(&report.run_id)
        .map_err(|_| LegacyMigrationError::InvalidRequest("invalid migration run id".into()))?;
    let layout = openbitfun_legacy_migration::MigrationLayout::new(roots, &report.run_id);
    let root = layout.stage_root().join("workspace-sessions");
    let manifest: WorkspaceSessionsManifest =
        read_bounded_json(&root, &root.join("manifest.json"))?;
    let plan: openbitfun_product_domains::legacy_migration::MigrationPlan = layout
        .read_json(&layout.plan_path())?
        .ok_or_else(|| LegacyMigrationError::InvalidPlan("migration plan is missing".into()))?;
    let counts = |actions: Vec<SessionImportAction>| MigrationItemCounts {
        imported: actions
            .iter()
            .filter(|a| **a == SessionImportAction::Import)
            .count() as u64,
        skipped: actions
            .iter()
            .filter(|a| **a != SessionImportAction::Import)
            .count() as u64,
    };
    let mut result = WorkspaceReportCounts {
        sessions: counts(manifest.sessions.iter().map(|e| e.action).collect()),
        workspaces: MigrationItemCounts {
            imported: manifest.workspace_id_map.len() as u64,
            skipped: 0,
        },
        assistant_directories: counts(
            manifest
                .assistant_workspaces
                .iter()
                .map(|e| e.action)
                .collect(),
        ),
    };
    let target_workspaces = plan
        .conflicts
        .iter()
        .filter(|c| c.code == "workspace_target_wins")
        .count() as u64;
    result.workspaces.imported = result.workspaces.imported.saturating_sub(target_workspaces);
    result.workspaces.skipped += target_workspaces;
    if let Some(domain) = report
        .domain_results
        .iter()
        .find(|r| r.domain == MigrationDomainId::WorkspaceSessions)
    {
        for diagnostic in &domain.warnings {
            match diagnostic.code.as_str() {
                "session_source_skipped" | "session_entry_skipped" => result.sessions.skipped += 1,
                "workspace_item_skipped" => result.workspaces.skipped += 1,
                "assistant_workspace_not_migrated" => result.assistant_directories.skipped += 1,
                _ => {}
            }
        }
    }
    Ok(result)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SessionImportAction {
    Import,
    Duplicate,
    TargetWins,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionManifestEntry {
    pub(crate) runtime_relative: String,
    pub(crate) session_id: String,
    pub(crate) action: SessionImportAction,
    pub(crate) expected_hash: String,
    pub(crate) turn_ids: BTreeSet<String>,
    pub(crate) relationship: Option<SessionRelationship>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeEventManifestEntry {
    pub(crate) session_id: String,
    pub(crate) action: SessionImportAction,
    pub(crate) expected_hash: String,
    pub(crate) turn_ids: BTreeSet<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AssistantWorkspaceManifestEntry {
    pub(crate) relative_path: String,
    pub(crate) action: SessionImportAction,
    pub(crate) expected_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceSessionsManifest {
    pub(crate) workspace_id_map: BTreeMap<String, String>,
    #[serde(default)]
    pub(crate) assistant_workspaces: Vec<AssistantWorkspaceManifestEntry>,
    pub(crate) sessions: Vec<SessionManifestEntry>,
    pub(crate) runtime_events: Vec<RuntimeEventManifestEntry>,
    pub(crate) target_workspace_existed: bool,
    pub(crate) target_workspace_hash: Option<String>,
    pub(crate) skipped_paths: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct LegacyWorkspacePersistenceData {
    workspaces: HashMap<String, WorkspaceInfo>,
    #[serde(default)]
    opened_workspace_ids: Vec<String>,
    current_workspace_id: Option<String>,
    #[serde(default)]
    recent_workspaces: Vec<String>,
    #[serde(default)]
    recent_assistant_workspaces: Vec<String>,
    #[serde(default)]
    primary_assistant_key: Option<PrimaryAssistantKey>,
    saved_at: chrono::DateTime<chrono::Utc>,
}

struct WorkspaceSessionsPlan {
    workspace_data: WorkspacePersistenceData,
    workspace_id_map: BTreeMap<String, String>,
    assistant_workspaces: Vec<PlannedAssistantWorkspace>,
    sessions: Vec<PlannedSession>,
    runtime_events: Vec<PlannedRuntimeEvent>,
    conflicts: Vec<MigrationConflict>,
    requires_relocation: Vec<String>,
    skipped_paths: Vec<String>,
    target_workspace_existed: bool,
    target_workspace_hash: Option<String>,
    logical_bytes: u64,
}

struct PlannedAssistantWorkspace {
    relative_path: PathBuf,
    source_path: PathBuf,
    action: SessionImportAction,
    expected_hash: String,
    logical_bytes: u64,
}

struct PlannedSession {
    runtime_relative: PathBuf,
    bundle: OfflineSessionBundle,
    auxiliary_files: Vec<(PathBuf, PathBuf)>,
    state_bytes_override: Option<Vec<u8>>,
    action: SessionImportAction,
    expected_hash: String,
}

struct PlannedRuntimeEvent {
    session_id: String,
    source_path: PathBuf,
    action: SessionImportAction,
    expected_hash: String,
    turn_ids: BTreeSet<String>,
}

impl LegacyDomainAdapter for WorkspaceSessionsAdapter {
    fn domain(&self) -> MigrationDomainId {
        MigrationDomainId::WorkspaceSessions
    }

    fn scan(&self, roots: &MigrationRoots) -> LegacyMigrationResult<DomainScan> {
        let plan = plan_workspace_sessions(roots)?;
        Ok(DomainScan {
            finding: ScanFinding {
                domain: self.domain(),
                code: if !plan.conflicts.iter().any(|conflict| conflict.resolution == ConflictResolution::ItemSkipped) { "legacy_workspace_sessions_supported" } else { "session_items_skipped" }.to_string(),
                severity: if plan.conflicts.is_empty() && plan.skipped_paths.is_empty() {
                    FindingSeverity::Info
                } else {
                    FindingSeverity::Warning
                },
                entity_count: (plan.workspace_id_map.len()
                    + plan.assistant_workspaces.len()
                    + plan.sessions.len()
                    + plan.runtime_events.len()) as u64,
                logical_bytes: plan.logical_bytes,
                source_schema: Some("bitfun.workspace-session.v1".to_string()),
                migratable: true,
                detail: format!(
                    "{} workspaces, {} personal assistant directories, {} Sessions, and {} runtime event logs are owner-readable",
                    plan.workspace_id_map.len(),
                    plan.assistant_workspaces.len(),
                    plan.sessions.len(),
                    plan.runtime_events.len()
                ),
            },
            conflicts: plan.conflicts,
            target_schema: Some("openbitfun.workspace-session.current".to_string()),
            dependencies: Vec::new(),
        })
    }

    fn stage(&self, context: &DomainContext<'_>) -> LegacyMigrationResult<MigrationDomainResult> {
        let mut plan = plan_workspace_sessions(context.roots)?;
        let domain_root = stage_domain_dir(context, "workspace-sessions");
        atomic_write_json(
            &domain_root.join("workspace_data.json"),
            &plan.workspace_data,
        )?;

        for workspace in &plan.assistant_workspaces {
            if workspace.action != SessionImportAction::Import {
                continue;
            }
            let staged = domain_root
                .join("personal-assistant")
                .join(&workspace.relative_path);
            copy_tree(&workspace.source_path, &staged)?;
            require_tree_hash(&staged, &workspace.expected_hash)?;
        }

        let runtime = offline_runtime()?;
        let mut failed_sessions = BTreeSet::new();
        for session in &mut plan.sessions {
            if session.action != SessionImportAction::Import {
                continue;
            }
            let sessions_root = domain_root.join("home").join(&session.runtime_relative);
            let store = OfflineSessionImportStore::new(&sessions_root);
            let staged_result = (|| -> LegacyMigrationResult<()> {
                runtime
                    .block_on(store.write_bundle(&session.bundle))
                    .map_err(|error| owner_error("write staged Session", error))?;
                let staged_session = sessions_root.join(&session.bundle.metadata.session_id);
                for (relative, source) in &session.auxiliary_files {
                    if relative == Path::new("state.json") {
                        if let Some(bytes) = &session.state_bytes_override {
                            atomic_write_bytes(&staged_session.join(relative), bytes)?;
                            continue;
                        }
                    }
                    let source_bytes = fs::read(source).map_err(|error| io_error(source, error))?;
                    atomic_write_bytes(&staged_session.join(relative), &source_bytes)?;
                }
                require_tree_hash(&staged_session, &session.expected_hash)?;
                Ok(())
            })();
            if staged_result.is_err() {
                failed_sessions.insert(session.bundle.metadata.session_id.clone());
                plan.conflicts.push(MigrationConflict {
                    domain: self.domain(),
                    code: "session_entry_skipped".into(),
                    source_summary: session.bundle.metadata.session_id.clone(),
                    target_summary: "Session could not be staged".into(),
                    resolution: ConflictResolution::ItemSkipped,
                });
                plan.skipped_paths
                    .push(session.bundle.metadata.session_id.clone());
            }
        }

        plan.sessions
            .retain(|session| !failed_sessions.contains(&session.bundle.metadata.session_id));
        plan.runtime_events
            .retain(|event| !failed_sessions.contains(&event.session_id));
        for event in &plan.runtime_events {
            if event.action != SessionImportAction::Import {
                continue;
            }
            let bytes = fs::read(&event.source_path)
                .map_err(|error| io_error(&event.source_path, error))?;
            atomic_write_bytes(
                &domain_root
                    .join("runtime-events")
                    .join(format!("{}.jsonl", event.session_id)),
                &bytes,
            )?;
        }

        let manifest = WorkspaceSessionsManifest {
            workspace_id_map: plan.workspace_id_map,
            assistant_workspaces: plan
                .assistant_workspaces
                .iter()
                .map(assistant_workspace_manifest_entry)
                .collect(),
            sessions: plan.sessions.iter().map(session_manifest_entry).collect(),
            runtime_events: plan
                .runtime_events
                .iter()
                .map(|event| RuntimeEventManifestEntry {
                    session_id: event.session_id.clone(),
                    action: event.action,
                    expected_hash: event.expected_hash.clone(),
                    turn_ids: event.turn_ids.clone(),
                })
                .collect(),
            target_workspace_existed: plan.target_workspace_existed,
            target_workspace_hash: plan.target_workspace_hash,
            skipped_paths: plan.skipped_paths,
        };
        atomic_write_json(&workspace_sessions_manifest_path(context), &manifest)?;

        let imported = manifest
            .sessions
            .iter()
            .filter(|entry| entry.action == SessionImportAction::Import)
            .count()
            + manifest
                .runtime_events
                .iter()
                .filter(|entry| entry.action == SessionImportAction::Import)
                .count()
            + manifest.workspace_id_map.len()
            + manifest
                .assistant_workspaces
                .iter()
                .filter(|entry| entry.action == SessionImportAction::Import)
                .count();
        let skipped = manifest
            .sessions
            .iter()
            .filter(|entry| entry.action != SessionImportAction::Import)
            .count()
            + manifest
                .runtime_events
                .iter()
                .filter(|entry| entry.action != SessionImportAction::Import)
                .count()
            + manifest
                .assistant_workspaces
                .iter()
                .filter(|entry| entry.action != SessionImportAction::Import)
                .count()
            + manifest.skipped_paths.len();
        let mut warnings = manifest
            .skipped_paths
            .iter()
            .map(|path| MigrationDiagnostic {
                code: "session_path_not_migrated".to_string(),
                severity: FindingSeverity::Info,
                domain: Some(self.domain()),
                relative_path: Some(path.clone()),
                message: "An unreadable, unsupported, or non-owned Session path was preserved in the legacy source"
                    .to_string(),
                action: None,
            })
            .collect::<Vec<_>>();
        warnings.extend(
            plan.conflicts
                .iter()
                .filter(|conflict| conflict.resolution == ConflictResolution::ItemSkipped)
                .map(|conflict| MigrationDiagnostic {
                    code: conflict.code.clone(),
                    severity: FindingSeverity::Warning,
                    domain: Some(self.domain()),
                    relative_path: Some(conflict.source_summary.clone()),
                    message: conflict.target_summary.clone(),
                    ..Default::default()
                }),
        );
        let orphaned_relationships = orphaned_session_relationship_count(&manifest);
        if orphaned_relationships > 0 {
            warnings.push(MigrationDiagnostic {
                code: "session_parent_not_present".to_string(),
                severity: FindingSeverity::Info,
                domain: Some(self.domain()),
                relative_path: None,
                message: format!(
                    "{orphaned_relationships} imported Sessions reference a parent Session that is not present in the legacy source; the relationship metadata was preserved"
                ),
                action: Some(
                    "No action is required; the affected Sessions remain available as standalone history"
                        .to_string(),
                ),
            });
        }
        Ok(MigrationDomainResult {
            domain: self.domain(),
            state: MigrationDomainState::Staged,
            imported: imported as u64,
            skipped: skipped as u64,
            conflicts: plan.conflicts.len() as u64,
            warnings,
            requires_relocation: plan.requires_relocation,
            ..MigrationDomainResult::default()
        })
    }

    fn validate_stage(&self, context: &DomainContext<'_>) -> LegacyMigrationResult<()> {
        let manifest = read_workspace_sessions_manifest(context)?;
        let domain_root = stage_domain_dir(context, "workspace-sessions");
        let workspace_data: WorkspacePersistenceData = read_bounded_json(
            &context.layout.stage_root(),
            &domain_root.join("workspace_data.json"),
        )?;
        validate_workspace_persistence_data(
            &workspace_data,
            &context.roots.target_user_root.join("data/miniapps"),
        )
        .map_err(|error| owner_error("validate staged Workspace registry", error))?;

        for entry in imported_assistant_workspaces(&manifest) {
            let path = domain_root
                .join("personal-assistant")
                .join(path_from_manifest(&entry.relative_path)?);
            require_tree_hash(&path, &entry.expected_hash)?;
        }

        let runtime = offline_runtime()?;
        for entry in imported_sessions(&manifest) {
            let sessions_root = domain_root
                .join("home")
                .join(path_from_manifest(&entry.runtime_relative)?);
            let store = OfflineSessionImportStore::new(&sessions_root);
            let bundle = runtime
                .block_on(store.load_bundle(&entry.session_id))
                .map_err(|error| owner_error("read staged Session", error))?
                .ok_or_else(|| {
                    LegacyMigrationError::InvalidRequest(format!(
                        "staged Session is missing: {}",
                        entry.session_id
                    ))
                })?;
            bundle
                .validate()
                .map_err(|error| owner_error("validate staged Session", error))?;
            require_tree_hash(&sessions_root.join(&entry.session_id), &entry.expected_hash)?;
        }
        for entry in imported_runtime_events(&manifest) {
            let path = domain_root
                .join("runtime-events")
                .join(format!("{}.jsonl", entry.session_id));
            validate_runtime_event_log(&path, &entry.session_id)
                .map_err(|error| owner_error("validate staged runtime event log", error))?;
            require_file_hash(&path, &entry.expected_hash)?;
        }
        Ok(())
    }

    fn commit(&self, context: &DomainContext<'_>) -> LegacyMigrationResult<()> {
        let manifest = read_workspace_sessions_manifest(context)?;
        let domain_root = stage_domain_dir(context, "workspace-sessions");
        let target_workspace = target_workspace_data_path(context.roots);
        let staged_workspace = domain_root.join("workspace_data.json");
        let staged_workspace_hash = hash_file(&staged_workspace)?;
        let workspace_already_applied = if target_workspace.exists() {
            validate_regular_file(&context.roots.target_user_root, &target_workspace)?;
            hash_file(&target_workspace)? == staged_workspace_hash
        } else {
            false
        };
        if !workspace_already_applied {
            verify_planned_file_state(
                &target_workspace,
                manifest.target_workspace_existed,
                manifest.target_workspace_hash.as_deref(),
            )?;
            backup_file_once(
                &target_workspace,
                &backup_domain_dir(context, "workspace-sessions").join("workspace_data.json"),
            )?;
            let workspace_bytes =
                fs::read(&staged_workspace).map_err(|error| io_error(&staged_workspace, error))?;
            atomic_write_bytes(&target_workspace, &workspace_bytes)?;
        }

        for entry in imported_assistant_workspaces(&manifest) {
            let relative = path_from_manifest(&entry.relative_path)?;
            install_directory_idempotent(
                &domain_root.join("personal-assistant").join(&relative),
                &context
                    .roots
                    .target_home_root
                    .join("personal_assistant")
                    .join(relative),
                &entry.expected_hash,
                &context.plan.run_id,
            )?;
        }

        for entry in imported_sessions(&manifest) {
            let relative = path_from_manifest(&entry.runtime_relative)?;
            let staged = domain_root
                .join("home")
                .join(&relative)
                .join(&entry.session_id);
            let target = context
                .roots
                .target_home_root
                .join(&relative)
                .join(&entry.session_id);
            install_directory_idempotent(
                &staged,
                &target,
                &entry.expected_hash,
                &context.plan.run_id,
            )?;
        }
        for entry in imported_runtime_events(&manifest) {
            let staged = domain_root
                .join("runtime-events")
                .join(format!("{}.jsonl", entry.session_id));
            let target = context
                .roots
                .target_home_root
                .join("runtime-events")
                .join(format!("{}.jsonl", entry.session_id));
            install_file_idempotent(&staged, &target, &entry.expected_hash)?;
        }
        Ok(())
    }

    fn validate_commit(&self, context: &DomainContext<'_>) -> LegacyMigrationResult<()> {
        let manifest = read_workspace_sessions_manifest(context)?;
        let expected: WorkspacePersistenceData = read_bounded_json(
            &context.layout.stage_root(),
            &stage_domain_dir(context, "workspace-sessions").join("workspace_data.json"),
        )?;
        let actual: WorkspacePersistenceData = read_bounded_json(
            &context.roots.target_user_root,
            &target_workspace_data_path(context.roots),
        )?;
        validate_workspace_persistence_data(
            &actual,
            &context.roots.target_user_root.join("data/miniapps"),
        )
        .map_err(|error| owner_error("validate committed Workspace registry", error))?;
        if serde_json::to_value(&expected).map_err(json_error)?
            != serde_json::to_value(&actual).map_err(json_error)?
        {
            return Err(LegacyMigrationError::InvalidRequest(
                "committed Workspace registry differs from the staged owner output".to_string(),
            ));
        }

        for entry in imported_assistant_workspaces(&manifest) {
            let path = context
                .roots
                .target_home_root
                .join("personal_assistant")
                .join(path_from_manifest(&entry.relative_path)?);
            require_tree_hash(&path, &entry.expected_hash)?;
        }

        let runtime = offline_runtime()?;
        for entry in imported_sessions(&manifest) {
            let relative = path_from_manifest(&entry.runtime_relative)?;
            let sessions_root = context.roots.target_home_root.join(&relative);
            let store = OfflineSessionImportStore::new(&sessions_root);
            let bundle = runtime
                .block_on(store.load_bundle(&entry.session_id))
                .map_err(|error| owner_error("read committed Session", error))?
                .ok_or_else(|| {
                    LegacyMigrationError::InvalidRequest(format!(
                        "committed Session is missing: {}",
                        entry.session_id
                    ))
                })?;
            bundle
                .validate()
                .map_err(|error| owner_error("validate committed Session", error))?;
            require_tree_hash(&sessions_root.join(&entry.session_id), &entry.expected_hash)?;
        }
        for entry in imported_runtime_events(&manifest) {
            let path = context
                .roots
                .target_home_root
                .join("runtime-events")
                .join(format!("{}.jsonl", entry.session_id));
            validate_runtime_event_log(&path, &entry.session_id)
                .map_err(|error| owner_error("validate committed runtime event log", error))?;
            require_file_hash(&path, &entry.expected_hash)?;
        }
        Ok(())
    }

    fn rollback_unverified(&self, context: &DomainContext<'_>) -> LegacyMigrationResult<()> {
        let Some(manifest) = read_optional_bounded_json::<WorkspaceSessionsManifest>(
            &context.layout.stage_root(),
            &workspace_sessions_manifest_path(context),
        )?
        else {
            return Ok(());
        };
        restore_unverified_file(
            &target_workspace_data_path(context.roots),
            &backup_domain_dir(context, "workspace-sessions").join("workspace_data.json"),
            manifest.target_workspace_existed,
        )?;
        let domain_root = stage_domain_dir(context, "workspace-sessions");
        for entry in imported_assistant_workspaces(&manifest) {
            let relative = path_from_manifest(&entry.relative_path)?;
            remove_directory_if_matches(
                &domain_root.join("personal-assistant").join(&relative),
                &context
                    .roots
                    .target_home_root
                    .join("personal_assistant")
                    .join(relative),
            )?;
        }
        for entry in imported_sessions(&manifest) {
            let relative = path_from_manifest(&entry.runtime_relative)?;
            remove_directory_if_matches(
                &domain_root
                    .join("home")
                    .join(&relative)
                    .join(&entry.session_id),
                &context
                    .roots
                    .target_home_root
                    .join(relative)
                    .join(&entry.session_id),
            )?;
        }
        for entry in imported_runtime_events(&manifest) {
            remove_file_if_matches(
                &domain_root
                    .join("runtime-events")
                    .join(format!("{}.jsonl", entry.session_id)),
                &context
                    .roots
                    .target_home_root
                    .join("runtime-events")
                    .join(format!("{}.jsonl", entry.session_id)),
            )?;
        }
        Ok(())
    }
}

fn skipped_workspace(id: &str) -> MigrationConflict {
    MigrationConflict {
        domain: MigrationDomainId::WorkspaceSessions,
        code: "workspace_item_skipped".into(),
        source_summary: id.to_string(),
        target_summary: "Source workspace retained; other data can continue.".into(),
        resolution: ConflictResolution::ItemSkipped,
    }
}

fn repair_workspace_lists(data: &mut WorkspacePersistenceData, miniapps_root: &Path) {
    for list in [
        &mut data.opened_workspace_ids,
        &mut data.recent_workspaces,
        &mut data.recent_assistant_workspaces,
    ] {
        let mut seen = HashSet::new();
        list.retain(|id| data.workspaces.contains_key(id) && seen.insert(id.clone()));
    }
    let recent = data
        .recent_workspaces
        .iter()
        .chain(&data.recent_assistant_workspaces)
        .cloned()
        .collect::<BTreeSet<_>>();
    data.recent_workspaces.retain(|id| {
        data.workspaces[id].workspace_kind != WorkspaceKind::Assistant
            && !data.workspaces[id].root_path.starts_with(miniapps_root)
    });
    data.recent_assistant_workspaces
        .retain(|id| data.workspaces[id].workspace_kind == WorkspaceKind::Assistant);
    for id in recent {
        let workspace = &data.workspaces[&id];
        if workspace.workspace_kind == WorkspaceKind::Assistant {
            if !data.recent_assistant_workspaces.contains(&id) {
                data.recent_assistant_workspaces.push(id);
            }
        } else if !workspace.root_path.starts_with(miniapps_root)
            && !data.recent_workspaces.contains(&id)
        {
            data.recent_workspaces.push(id);
        }
    }
    if data
        .current_workspace_id
        .as_ref()
        .is_some_and(|id| !data.workspaces.contains_key(id))
    {
        data.current_workspace_id = None;
    }
    if let Some(id) = &data.current_workspace_id {
        if !data.opened_workspace_ids.contains(id) {
            data.opened_workspace_ids.push(id.clone());
        }
    }
}

fn plan_workspace_sessions(roots: &MigrationRoots) -> LegacyMigrationResult<WorkspaceSessionsPlan> {
    let source_workspace_path = source_workspace_data_path(roots);
    let mut conflicts = Vec::new();
    let mut raw: serde_json::Value =
        match read_bounded_json(&roots.legacy_user_root, &source_workspace_path) {
            Ok(value) => value,
            Err(_) => {
                conflicts.push(skipped_workspace("registry"));
                serde_json::json!({})
            }
        };
    let mut workspaces = serde_json::Map::new();
    if let Some(entries) = raw.get("workspaces").and_then(serde_json::Value::as_object) {
        for (id, value) in entries {
            if serde_json::from_value::<WorkspaceInfo>(value.clone()).is_ok() {
                workspaces.insert(id.clone(), value.clone());
            } else {
                conflicts.push(skipped_workspace(id));
            }
        }
    }
    if !raw.is_object() {
        raw = serde_json::json!({});
    }
    raw["workspaces"] = serde_json::Value::Object(workspaces);
    for key in [
        "opened_workspace_ids",
        "recent_workspaces",
        "recent_assistant_workspaces",
    ] {
        raw[key] = serde_json::Value::Array(
            raw.get(key)
                .and_then(serde_json::Value::as_array)
                .into_iter()
                .flatten()
                .filter(|value| value.is_string())
                .cloned()
                .collect(),
        );
    }
    if raw
        .get("current_workspace_id")
        .is_some_and(|value| !value.is_string())
    {
        raw["current_workspace_id"] = serde_json::Value::Null;
    }
    if serde_json::from_value::<Option<PrimaryAssistantKey>>(
        raw.get("primary_assistant_key")
            .cloned()
            .unwrap_or_default(),
    )
    .is_err()
    {
        raw["primary_assistant_key"] = serde_json::Value::Null;
    }
    if serde_json::from_value::<chrono::DateTime<chrono::Utc>>(
        raw.get("saved_at").cloned().unwrap_or_default(),
    )
    .is_err()
    {
        raw["saved_at"] = serde_json::json!(chrono::DateTime::<chrono::Utc>::UNIX_EPOCH);
    }
    let legacy: LegacyWorkspacePersistenceData = serde_json::from_value(raw).map_err(json_error)?;
    let target_workspace_path = target_workspace_data_path(roots);
    let mut target = read_optional_bounded_json::<WorkspacePersistenceData>(
        &roots.target_user_root,
        &target_workspace_path,
    )?;
    if let Some(target) = &mut target {
        repair_workspace_lists(target, &roots.target_user_root.join("data/miniapps"));
        validate_workspace_persistence_data(target, &roots.target_user_root.join("data/miniapps"))
            .map_err(|error| owner_error("read current Workspace registry", error))?;
    }

    let assistant_workspaces = plan_assistant_workspaces(roots, &mut conflicts)?;
    let mut assistant_path_relocations = BTreeMap::new();
    for workspace in &assistant_workspaces {
        assistant_path_relocations.insert(
            native_path_key(&workspace.source_path),
            roots
                .target_home_root
                .join("personal_assistant")
                .join(&workspace.relative_path),
        );
    }

    let mut workspace_id_map = BTreeMap::new();
    let mut converted = Vec::new();
    let mut source_workspace_ids = legacy.workspaces.keys().cloned().collect::<Vec<_>>();
    source_workspace_ids.sort();
    let mut requires_relocation = Vec::new();
    for source_id in source_workspace_ids {
        let inspect = (|| -> LegacyMigrationResult<()> {
            let mut workspace = legacy.workspaces[&source_id].clone();
            let relocated_assistant = (workspace.workspace_kind == WorkspaceKind::Assistant)
                .then(|| assistant_path_relocations.get(&native_path_key(&workspace.root_path)))
                .flatten()
                .cloned();
            if let Some(target_path) = &relocated_assistant {
                workspace.root_path = target_path.clone();
            }
            normalize_legacy_workspace_for_current(&mut workspace)?;
            let target_id = legacy_workspace_storage_id(&workspace)
                .map_err(|error| owner_error("convert legacy Workspace id", error))?;
            workspace.id = target_id.clone();
            if workspace.workspace_kind != WorkspaceKind::Remote
                && relocated_assistant.is_none()
                && !workspace.root_path.exists()
            {
                requires_relocation.push(target_id.clone());
            }
            workspace_id_map.insert(source_id.clone(), target_id.clone());
            converted.push((target_id, workspace));
            Ok(())
        })();
        if inspect.is_err() {
            conflicts.push(skipped_workspace(&source_id));
        }
    }

    let mut output_workspaces = target
        .as_ref()
        .map(|value| value.workspaces.clone())
        .unwrap_or_default();
    for (target_id, workspace) in converted {
        if let Some(existing) = output_workspaces.get(&target_id) {
            if serde_json::to_value(existing).map_err(json_error)?
                != serde_json::to_value(&workspace).map_err(json_error)?
            {
                conflicts.push(MigrationConflict {
                    domain: MigrationDomainId::WorkspaceSessions,
                    code: "workspace_target_wins".to_string(),
                    source_summary: format!("legacy Workspace {target_id}"),
                    target_summary: format!("current Workspace {target_id}"),
                    resolution: ConflictResolution::TargetWins,
                });
            }
        } else {
            output_workspaces.insert(target_id, workspace);
        }
    }

    let mut opened_workspace_ids = merge_reference_list(
        target.as_ref().map(|value| &value.opened_workspace_ids),
        &legacy.opened_workspace_ids,
        &workspace_id_map,
        &output_workspaces,
    );
    let recent_workspaces = merge_reference_list(
        target.as_ref().map(|value| &value.recent_workspaces),
        &legacy.recent_workspaces,
        &workspace_id_map,
        &output_workspaces,
    );
    let recent_assistant_workspaces = merge_reference_list(
        target
            .as_ref()
            .map(|value| &value.recent_assistant_workspaces),
        &legacy.recent_assistant_workspaces,
        &workspace_id_map,
        &output_workspaces,
    );
    let source_current = legacy
        .current_workspace_id
        .as_ref()
        .and_then(|id| workspace_id_map.get(id))
        .filter(|id| output_workspaces.contains_key(*id))
        .cloned();
    let current_workspace_id = target
        .as_ref()
        .and_then(|value| value.current_workspace_id.clone())
        .or(source_current);
    if let Some(current_id) = current_workspace_id.as_ref() {
        if !opened_workspace_ids.iter().any(|id| id == current_id) {
            opened_workspace_ids.push(current_id.clone());
        }
    }
    let mut workspace_data = WorkspacePersistenceData {
        format_version: WORKSPACE_PERSISTENCE_FORMAT_VERSION,
        product_id: product_id().to_string(),
        workspaces: output_workspaces,
        opened_workspace_ids,
        current_workspace_id,
        recent_workspaces,
        recent_assistant_workspaces,
        primary_assistant_key: target
            .as_ref()
            .and_then(|value| value.primary_assistant_key.clone())
            .or(legacy.primary_assistant_key),
        saved_at: target
            .as_ref()
            .map(|value| value.saved_at)
            .unwrap_or(legacy.saved_at),
    };
    repair_workspace_lists(
        &mut workspace_data,
        &roots.target_user_root.join("data/miniapps"),
    );
    validate_workspace_persistence_data(
        &workspace_data,
        &roots.target_user_root.join("data/miniapps"),
    )
    .map_err(|error| owner_error("convert legacy Workspace registry", error))?;

    let target_sessions = index_target_sessions(roots)?;
    let (sessions, mut skipped_paths) = plan_sessions(
        roots,
        &target_sessions,
        &assistant_path_relocations,
        &mut conflicts,
    )?;
    let runtime_events = plan_runtime_events(roots, &sessions, &mut conflicts, &mut skipped_paths)?;
    let session_bytes = sessions.iter().try_fold(0u64, |total, session| {
        expected_session_bytes(session).map(|bytes| total.saturating_add(bytes))
    })?;
    let event_bytes = runtime_events
        .iter()
        .map(|event| {
            fs::metadata(&event.source_path)
                .map(|metadata| metadata.len())
                .unwrap_or(0)
        })
        .sum::<u64>();
    let workspace_bytes = fs::metadata(&source_workspace_path).map_or(0, |metadata| metadata.len());
    let target_workspace_existed = target_workspace_path.exists();
    let target_workspace_hash = target_workspace_existed
        .then(|| hash_file(&target_workspace_path))
        .transpose()?;

    let assistant_bytes = assistant_workspaces
        .iter()
        .map(|workspace| workspace.logical_bytes)
        .sum::<u64>();
    Ok(WorkspaceSessionsPlan {
        workspace_data,
        workspace_id_map,
        assistant_workspaces,
        sessions,
        runtime_events,
        conflicts,
        requires_relocation,
        skipped_paths,
        target_workspace_existed,
        target_workspace_hash,
        logical_bytes: workspace_bytes
            .saturating_add(assistant_bytes)
            .saturating_add(session_bytes)
            .saturating_add(event_bytes),
    })
}

fn normalize_legacy_workspace_for_current(
    workspace: &mut WorkspaceInfo,
) -> LegacyMigrationResult<()> {
    if workspace.workspace_kind == WorkspaceKind::Remote {
        let normalized = normalize_remote_workspace_path(&workspace.root_path.to_string_lossy());
        if !normalized.starts_with('/') {
            return Err(LegacyMigrationError::UnsupportedSource(format!(
                "remote Workspace {} does not use an absolute POSIX root",
                workspace.id
            )));
        }
        workspace.root_path = PathBuf::from(normalized);
    } else {
        workspace.metadata.insert(
            "sshHost".to_string(),
            serde_json::Value::String(LOCAL_WORKSPACE_SSH_HOST.to_string()),
        );
        if workspace.root_path.exists() {
            let (canonical, _) = canonicalize_local_workspace_root(&workspace.root_path)
                .map_err(|error| owner_error("canonicalize legacy Workspace root", error))?;
            workspace.root_path = canonical;
        }
    }
    Ok(())
}

fn plan_assistant_workspaces(
    roots: &MigrationRoots,
    conflicts: &mut Vec<MigrationConflict>,
) -> LegacyMigrationResult<Vec<PlannedAssistantWorkspace>> {
    let source_root = roots.legacy_home_root.join("personal_assistant");
    if !source_root.exists() {
        return Ok(Vec::new());
    }
    let target_root = roots.target_home_root.join("personal_assistant");
    let mut planned = Vec::new();
    for source_path in child_directories(&source_root)? {
        let relative_path = PathBuf::from(file_name(&source_path)?);
        let (expected_hash, logical_bytes) = match hash_tree_with_size(&source_path) {
            Ok(value) => value,
            Err(error) => {
                conflicts.push(MigrationConflict {
                    domain: MigrationDomainId::WorkspaceSessions,
                    code: "assistant_workspace_not_migrated".into(),
                    source_summary: relative_display(&roots.legacy_home_root, &source_path),
                    target_summary: format!("Source workspace retained: {error}"),
                    resolution: ConflictResolution::ItemSkipped,
                });
                continue;
            }
        };
        let target_path = target_root.join(&relative_path);
        let action = if !target_path.exists() {
            SessionImportAction::Import
        } else if hash_tree(&target_path)? == expected_hash {
            SessionImportAction::Duplicate
        } else {
            conflicts.push(MigrationConflict {
                domain: MigrationDomainId::WorkspaceSessions,
                code: "assistant_workspace_target_wins".to_string(),
                source_summary: format!(
                    "legacy personal assistant workspace {}",
                    relative_path.display()
                ),
                target_summary: format!(
                    "current personal assistant workspace {}",
                    relative_path.display()
                ),
                resolution: ConflictResolution::TargetWins,
            });
            SessionImportAction::TargetWins
        };
        planned.push(PlannedAssistantWorkspace {
            relative_path,
            source_path,
            action,
            expected_hash,
            logical_bytes,
        });
    }
    Ok(planned)
}

fn relocate_assistant_session_metadata(
    metadata: &mut SessionMetadata,
    relocations: &BTreeMap<String, PathBuf>,
) -> Option<PathBuf> {
    let project_workspace =
        relocate_session_path(&mut metadata.project_workspace_path, relocations);
    let workspace = relocate_session_path(&mut metadata.workspace_path, relocations);
    let execution = metadata.execution_target.as_mut().and_then(|target| {
        let relocated = relocations.get(&native_path_key(Path::new(&target.root_path)))?;
        target.root_path = relocated.to_string_lossy().into_owned();
        Some(relocated.clone())
    });
    project_workspace.or(workspace).or(execution)
}

fn relocate_session_path(
    value: &mut Option<String>,
    relocations: &BTreeMap<String, PathBuf>,
) -> Option<PathBuf> {
    let relocated = relocations.get(&native_path_key(Path::new(value.as_deref()?)))?;
    *value = Some(relocated.to_string_lossy().into_owned());
    Some(relocated.clone())
}

fn relocate_assistant_session_state(
    legacy_home_root: &Path,
    state_path: &Path,
    relocations: &BTreeMap<String, PathBuf>,
) -> LegacyMigrationResult<Option<Vec<u8>>> {
    if !state_path.is_file() {
        return Ok(None);
    }
    let mut state: serde_json::Value = read_bounded_json(legacy_home_root, state_path)?;
    let Some(config) = state
        .get_mut("config")
        .and_then(serde_json::Value::as_object_mut)
    else {
        return Ok(None);
    };

    let mut changed = false;
    for key in ["workspace_path", "project_workspace_path"] {
        if let Some(value) = config.get_mut(key) {
            changed |= relocate_json_path(value, relocations);
        }
    }
    if let Some(execution_target) = config
        .get_mut("execution_target")
        .and_then(serde_json::Value::as_object_mut)
    {
        for key in ["rootPath", "root_path"] {
            if let Some(value) = execution_target.get_mut(key) {
                changed |= relocate_json_path(value, relocations);
            }
        }
    }

    changed
        .then(|| serde_json::to_vec(&state).map_err(json_error))
        .transpose()
}

fn relocate_json_path(
    value: &mut serde_json::Value,
    relocations: &BTreeMap<String, PathBuf>,
) -> bool {
    let Some(source_path) = value.as_str() else {
        return false;
    };
    let Some(target_path) = relocations.get(&native_path_key(Path::new(source_path))) else {
        return false;
    };
    *value = serde_json::Value::String(target_path.to_string_lossy().into_owned());
    true
}

fn assistant_session_runtime_relative(workspace_path: PathBuf) -> PathBuf {
    // New destinations do not exist during planning. Resolve the existing
    // parent and rebuild native separators so the slug hash matches the path
    // Desktop will canonicalize after commit (including long Windows paths).
    let mut parent = workspace_path.as_path();
    let mut suffix = Vec::new();
    while !parent.exists() {
        let (Some(name), Some(next)) = (parent.file_name(), parent.parent()) else {
            break;
        };
        suffix.push(name);
        parent = next;
    }
    let mut canonical = dunce::canonicalize(parent).unwrap_or_else(|_| parent.to_path_buf());
    for component in suffix.into_iter().rev() {
        canonical.push(component);
    }
    let slug = build_project_runtime_slug(&canonical.to_string_lossy());
    PathBuf::from("projects").join(slug).join("sessions")
}

fn native_path_key(path: &Path) -> String {
    let key = path
        .to_string_lossy()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string();
    #[cfg(windows)]
    {
        key.to_ascii_lowercase()
    }
    #[cfg(not(windows))]
    {
        key
    }
}

fn plan_sessions(
    roots: &MigrationRoots,
    target_sessions: &HashMap<String, Vec<PathBuf>>,
    assistant_path_relocations: &BTreeMap<String, PathBuf>,
    conflicts: &mut Vec<MigrationConflict>,
) -> LegacyMigrationResult<(Vec<PlannedSession>, Vec<String>)> {
    let session_roots = find_session_roots(&roots.legacy_home_root)?;
    let mut sessions = Vec::new();
    let mut skipped_paths = Vec::new();
    let mut source_ids = HashMap::<String, String>::new();
    for sessions_root in session_roots {
        let source_runtime_relative = sessions_root
            .strip_prefix(&roots.legacy_home_root)
            .map_err(|_| LegacyMigrationError::PathEscape(sessions_root.clone()))?
            .to_path_buf();
        for session_dir in child_directories(&sessions_root)? {
            let inspect = (|| -> LegacyMigrationResult<()> {
                let session_id = file_name(&session_dir)?;
                validate_session_id(&session_id).map_err(|error| {
                    LegacyMigrationError::UnsupportedSource(format!(
                        "legacy Session id is unsafe: {error}"
                    ))
                })?;
                let metadata_path = session_dir.join("metadata.json");
                match fs::symlink_metadata(&metadata_path) {
                    Ok(_) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        skipped_paths.push(relative_display(&roots.legacy_home_root, &session_dir));
                        return Ok(());
                    }
                    Err(error) => return Err(io_error(&metadata_path, error)),
                }
                let metadata_file: StoredSessionMetadataFile =
                    read_bounded_json(&roots.legacy_home_root, &metadata_path)?;
                if metadata_file.schema_version > SESSION_STORAGE_SCHEMA_VERSION {
                    return Err(LegacyMigrationError::UnsupportedSource(format!(
                        "Session {session_id} uses unsupported schema {}",
                        metadata_file.schema_version
                    )));
                }
                if metadata_file.metadata.session_id != session_id {
                    return Err(LegacyMigrationError::UnsupportedSource(format!(
                        "Session directory id does not match its metadata: {session_id}"
                    )));
                }
                let (turns, turn_issues) =
                    read_session_turns(&roots.legacy_home_root, &session_dir, &session_id)?;
                skipped_paths.extend(turn_issues.iter().cloned());
                if !turn_issues.is_empty() {
                    conflicts.push(MigrationConflict { domain: MigrationDomainId::WorkspaceSessions, code: "session_turns_recovered".into(), source_summary: session_id.clone(), target_summary: "Only readable, unambiguous Turns will be imported; inspect the original Session for omitted content.".into(), resolution: ConflictResolution::ItemSkipped });
                }
                let mut session_metadata = metadata_file.metadata;
                // Legacy metadata counters can lag persisted Turns. Rebuild the
                // derived count in the import copy without changing the source.
                session_metadata.turn_count = turns.len();
                let relocated_assistant_path = relocate_assistant_session_metadata(
                    &mut session_metadata,
                    assistant_path_relocations,
                );
                let runtime_relative = relocated_assistant_path
                    .clone()
                    .map(assistant_session_runtime_relative)
                    .unwrap_or_else(|| source_runtime_relative.clone());
                let bundle = OfflineSessionBundle {
                    metadata: session_metadata,
                    turns,
                };
                bundle
                    .validate()
                    .map_err(|error| owner_error("validate legacy Session", error))?;
                let mut auxiliary_files = collect_auxiliary_session_files(
                    &roots.legacy_home_root,
                    &session_dir,
                    &mut skipped_paths,
                )?;
                if !turn_issues.is_empty() {
                    auxiliary_files.retain(|(relative, _)| {
                        !matches!(
                            relative.to_str(),
                            Some("turn-catalog.json" | "token-anchors.json")
                        )
                    });
                }
                let state_bytes_override = if relocated_assistant_path.is_some()
                    && auxiliary_files
                        .iter()
                        .any(|(relative, _)| relative == Path::new("state.json"))
                {
                    relocate_assistant_session_state(
                        &roots.legacy_home_root,
                        &session_dir.join("state.json"),
                        assistant_path_relocations,
                    )?
                } else {
                    None
                };
                let expected_hash = expected_session_hash(
                    &bundle,
                    &auxiliary_files,
                    state_bytes_override.as_deref(),
                )?;
                if auxiliary_files
                    .len()
                    .saturating_add(bundle.turns.len())
                    .saturating_add(1)
                    > MAX_SESSION_FILES
                {
                    return Err(LegacyMigrationError::ResourceLimit(format!(
                        "Session contains more than {MAX_SESSION_FILES} files: {}",
                        session_dir.display()
                    )));
                }
                if expected_bundle_bytes(
                    &bundle,
                    &auxiliary_files,
                    state_bytes_override.as_deref(),
                )? > MAX_SESSION_BYTES
                {
                    return Err(LegacyMigrationError::ResourceLimit(format!(
                        "Session exceeds {MAX_SESSION_BYTES} bytes: {}",
                        session_dir.display()
                    )));
                }
                if let Some(previous_hash) = source_ids.get(&session_id) {
                    if previous_hash != &expected_hash {
                        return Err(LegacyMigrationError::UnsupportedSource(format!(
                            "legacy Session id appears with different contents: {session_id}"
                        )));
                    }
                    skipped_paths.push(relative_display(&roots.legacy_home_root, &session_dir));
                    return Ok(());
                }

                let target_same_path = roots
                    .target_home_root
                    .join(&runtime_relative)
                    .join(&session_id);
                let action = match target_sessions.get(&session_id) {
                    None => SessionImportAction::Import,
                    Some(paths)
                        if paths.len() == 1
                            && paths[0] == target_same_path
                            && hash_tree(&target_same_path)? == expected_hash =>
                    {
                        SessionImportAction::Duplicate
                    }
                    Some(_) => {
                        conflicts.push(MigrationConflict {
                            domain: MigrationDomainId::WorkspaceSessions,
                            code: "session_target_wins".to_string(),
                            source_summary: format!("legacy Session {session_id}"),
                            target_summary: format!("current Session {session_id}"),
                            resolution: ConflictResolution::TargetWins,
                        });
                        SessionImportAction::TargetWins
                    }
                };
                source_ids.insert(session_id.clone(), expected_hash.clone());
                sessions.push(PlannedSession {
                    runtime_relative: runtime_relative.clone(),
                    bundle,
                    auxiliary_files,
                    state_bytes_override,
                    action,
                    expected_hash,
                });
                Ok(())
            })();
            if let Err(error) = inspect {
                skipped_paths.push(relative_display(&roots.legacy_home_root, &session_dir));
                conflicts.push(MigrationConflict {
                    domain: MigrationDomainId::WorkspaceSessions,
                    code: "session_source_skipped".to_string(),
                    source_summary: error.to_string(),
                    target_summary:
                        "The original Session is preserved; other Sessions can be imported."
                            .to_string(),
                    resolution: ConflictResolution::ItemSkipped,
                });
            }
        }
    }
    sessions.sort_by(|left, right| {
        (&left.runtime_relative, &left.bundle.metadata.session_id)
            .cmp(&(&right.runtime_relative, &right.bundle.metadata.session_id))
    });
    Ok((sessions, skipped_paths))
}

fn plan_runtime_events(
    roots: &MigrationRoots,
    sessions: &[PlannedSession],
    conflicts: &mut Vec<MigrationConflict>,
    skipped_paths: &mut Vec<String>,
) -> LegacyMigrationResult<Vec<PlannedRuntimeEvent>> {
    let source_root = roots.legacy_home_root.join("runtime-events");
    if !source_root.exists() {
        return Ok(Vec::new());
    }
    reject_linked_directory(&source_root)?;
    let known_sessions = sessions
        .iter()
        .map(|session| (session.bundle.metadata.session_id.as_str(), session.action))
        .collect::<HashMap<_, _>>();
    let mut planned = Vec::new();
    for entry in read_dir_sorted(&source_root)? {
        let path = entry.path();
        let inspect = (|| -> LegacyMigrationResult<()> {
            let metadata = fs::symlink_metadata(&path).map_err(|error| io_error(&path, error))?;
            if metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
                return Err(LegacyMigrationError::LinkedPath(path.clone()));
            }
            if !metadata.is_file()
                || path.extension().and_then(|value| value.to_str()) != Some("jsonl")
            {
                skipped_paths.push(relative_display(&roots.legacy_home_root, &path));
                return Ok(());
            }
            if metadata.len() > MAX_RUNTIME_EVENT_BYTES {
                return Err(LegacyMigrationError::ResourceLimit(format!(
                    "runtime event log exceeds {MAX_RUNTIME_EVENT_BYTES} bytes: {}",
                    relative_display(&roots.legacy_home_root, &path)
                )));
            }
            validate_regular_file(&roots.legacy_home_root, &path)?;
            let session_id = path
                .file_stem()
                .and_then(|value| value.to_str())
                .ok_or_else(|| {
                    LegacyMigrationError::UnsupportedSource(
                        "runtime event log name is not valid UTF-8".to_string(),
                    )
                })?
                .to_string();
            let Some(session_action) = known_sessions.get(session_id.as_str()).copied() else {
                skipped_paths.push(relative_display(&roots.legacy_home_root, &path));
                return Ok(());
            };
            let summary = validate_runtime_event_log(&path, &session_id)
                .map_err(|error| owner_error("read legacy runtime event log", error))?;
            let expected_hash = hash_file(&path)?;
            let target = roots
                .target_home_root
                .join("runtime-events")
                .join(format!("{session_id}.jsonl"));
            let action = if session_action == SessionImportAction::TargetWins {
                SessionImportAction::TargetWins
            } else if !target.exists() {
                SessionImportAction::Import
            } else if hash_file(&target)? == expected_hash {
                SessionImportAction::Duplicate
            } else {
                conflicts.push(MigrationConflict {
                    domain: MigrationDomainId::WorkspaceSessions,
                    code: "runtime_event_target_wins".to_string(),
                    source_summary: format!("legacy runtime event log for {session_id}"),
                    target_summary: format!("current runtime event log for {session_id}"),
                    resolution: ConflictResolution::TargetWins,
                });
                SessionImportAction::TargetWins
            };
            planned.push(PlannedRuntimeEvent {
                session_id,
                source_path: path.clone(),
                action,
                expected_hash,
                turn_ids: summary.turn_ids,
            });
            Ok(())
        })();
        if let Err(error) = inspect {
            skipped_paths.push(relative_display(&roots.legacy_home_root, &path));
            conflicts.push(MigrationConflict {
                domain: MigrationDomainId::WorkspaceSessions,
                code: "session_event_log_skipped".to_string(),
                source_summary: error.to_string(),
                target_summary: "The original event log is preserved.".to_string(),
                resolution: ConflictResolution::ItemSkipped,
            });
        }
    }
    planned.sort_by(|left, right| left.session_id.cmp(&right.session_id));
    Ok(planned)
}

fn read_session_turns(
    legacy_home_root: &Path,
    session_dir: &Path,
    session_id: &str,
) -> LegacyMigrationResult<(
    Vec<openbitfun_services_core::session::DialogTurnData>,
    Vec<String>,
)> {
    let turns_dir = session_dir.join("turns");
    if !turns_dir.exists() {
        return Ok((Vec::new(), Vec::new()));
    }
    reject_linked_directory(&turns_dir)?;
    let mut turns = Vec::new();
    let mut issues = Vec::new();
    for entry in read_dir_sorted(&turns_dir)? {
        let path = entry.path();
        let inspect = (|| -> LegacyMigrationResult<_> {
            let stored: StoredDialogTurnFile = read_bounded_json(legacy_home_root, &path)?;
            if stored.schema_version > SESSION_STORAGE_SCHEMA_VERSION
                || stored.turn.session_id != session_id
            {
                return Err(LegacyMigrationError::UnsupportedSource(
                    "unsupported Turn schema or Session identity".into(),
                ));
            }
            Ok(stored.turn)
        })();
        match inspect {
            Ok(turn) => {
                let expected = format!("turn-{:04}.json", turn.turn_index);
                if path.file_name().and_then(|name| name.to_str()) != Some(expected.as_str()) {
                    issues.push(relative_display(legacy_home_root, &path));
                }
                turns.push(turn);
            }
            Err(_) => issues.push(relative_display(legacy_home_root, &path)),
        }
    }
    let mut seen_payloads = BTreeSet::new();
    turns.retain(|turn| {
        let unique = seen_payloads
            .insert(serde_json::to_vec(turn).expect("Turn serialization is infallible"));
        if !unique {
            issues.push(format!(
                "{}/turns/duplicate",
                relative_display(legacy_home_root, session_dir)
            ));
        }
        unique
    });
    // Conflicting identities cannot safely choose a winner. Preserve every
    // original and exclude the ambiguous group from this import.
    let mut ids = HashMap::new();
    let mut indices = HashMap::new();
    for turn in &turns {
        *ids.entry(turn.turn_id.clone()).or_insert(0usize) += 1;
        *indices.entry(turn.turn_index).or_insert(0usize) += 1;
    }
    turns.retain(|turn| {
        let keep = ids[&turn.turn_id] == 1 && indices[&turn.turn_index] == 1;
        if !keep {
            issues.push(format!(
                "{}/turns/turn-{:04}.json",
                relative_display(legacy_home_root, session_dir),
                turn.turn_index
            ));
        }
        keep
    });
    turns.sort_by_key(|turn| turn.turn_index);
    Ok((turns, issues))
}

fn collect_auxiliary_session_files(
    legacy_home_root: &Path,
    session_dir: &Path,
    skipped_paths: &mut Vec<String>,
) -> LegacyMigrationResult<Vec<(PathBuf, PathBuf)>> {
    let mut files = Vec::new();
    for entry in read_dir_sorted(session_dir)? {
        let path = entry.path();
        let name = file_name(&path)?;
        let metadata = fs::symlink_metadata(&path).map_err(|error| io_error(&path, error))?;
        if metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
            skipped_paths.push(relative_display(legacy_home_root, &path));
            continue;
        }
        if metadata.is_file() {
            if name == "metadata.json" {
                continue;
            }
            if SESSION_REBUILDABLE_ROOT_FILES.contains(&name.as_str()) {
                continue;
            }
            if SESSION_ROOT_FILES.contains(&name.as_str()) {
                if validate_owned_file(legacy_home_root, session_dir, &path, &mut files).is_err() {
                    skipped_paths.push(relative_display(legacy_home_root, &path));
                }
            } else {
                skipped_paths.push(relative_display(legacy_home_root, &path));
            }
        } else if metadata.is_dir() {
            if name == "turns" {
                continue;
            }
            if SESSION_OWNED_DIRECTORIES.contains(&name.as_str()) {
                if collect_owned_directory(legacy_home_root, session_dir, &path, 0, &mut files)
                    .is_err()
                {
                    skipped_paths.push(relative_display(legacy_home_root, &path));
                }
            } else {
                skipped_paths.push(relative_display(legacy_home_root, &path));
            }
        } else {
            skipped_paths.push(relative_display(legacy_home_root, &path));
        }
    }
    enforce_session_limits(session_dir, &files)?;
    Ok(files)
}

fn collect_owned_directory(
    legacy_home_root: &Path,
    session_dir: &Path,
    directory: &Path,
    depth: usize,
    files: &mut Vec<(PathBuf, PathBuf)>,
) -> LegacyMigrationResult<()> {
    if depth > MAX_RUNTIME_DEPTH {
        return Err(LegacyMigrationError::ResourceLimit(format!(
            "Session directory depth exceeds {MAX_RUNTIME_DEPTH}: {}",
            relative_display(legacy_home_root, directory)
        )));
    }
    reject_linked_directory(directory)?;
    for entry in read_dir_sorted(directory)? {
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(|error| io_error(&path, error))?;
        if metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
            return Err(LegacyMigrationError::LinkedPath(path));
        }
        if metadata.is_dir() {
            collect_owned_directory(legacy_home_root, session_dir, &path, depth + 1, files)?;
        } else if metadata.is_file() {
            validate_owned_file(legacy_home_root, session_dir, &path, files)?;
        }
    }
    Ok(())
}

fn validate_owned_file(
    legacy_home_root: &Path,
    session_dir: &Path,
    path: &Path,
    files: &mut Vec<(PathBuf, PathBuf)>,
) -> LegacyMigrationResult<()> {
    validate_regular_file(legacy_home_root, path)?;
    let relative = path
        .strip_prefix(session_dir)
        .map_err(|_| LegacyMigrationError::PathEscape(path.to_path_buf()))?
        .to_path_buf();
    files.push((relative, path.to_path_buf()));
    Ok(())
}

fn enforce_session_limits(
    session_dir: &Path,
    files: &[(PathBuf, PathBuf)],
) -> LegacyMigrationResult<()> {
    let mut total = 0u64;
    for (_, path) in files {
        let size = fs::metadata(path)
            .map_err(|error| io_error(path, error))?
            .len();
        if size > MAX_SESSION_FILE_BYTES {
            return Err(LegacyMigrationError::ResourceLimit(format!(
                "Session file exceeds {MAX_SESSION_FILE_BYTES} bytes: {}",
                path.display()
            )));
        }
        total = total.saturating_add(size);
    }
    if total > MAX_SESSION_BYTES {
        return Err(LegacyMigrationError::ResourceLimit(format!(
            "Session exceeds {MAX_SESSION_BYTES} bytes: {}",
            session_dir.display()
        )));
    }
    Ok(())
}

fn index_target_sessions(
    roots: &MigrationRoots,
) -> LegacyMigrationResult<HashMap<String, Vec<PathBuf>>> {
    let mut by_id = HashMap::<String, Vec<PathBuf>>::new();
    for sessions_root in find_session_roots(&roots.target_home_root)? {
        for session_dir in child_directories(&sessions_root)? {
            by_id
                .entry(file_name(&session_dir)?)
                .or_default()
                .push(session_dir);
        }
    }
    for paths in by_id.values_mut() {
        paths.sort();
    }
    Ok(by_id)
}

fn find_session_roots(home_root: &Path) -> LegacyMigrationResult<Vec<PathBuf>> {
    let mut found = Vec::new();
    let mut visited = 0usize;
    // Local and assistant Sessions share projects/<slug>/sessions. Workspace
    // content (including personal_assistant) is not a runtime discovery root.
    // Do not descend into snapshots, plugin data, or user build/dependency trees.
    let projects = home_root.join("projects");
    if projects.exists() {
        for runtime in child_directories(&projects)? {
            visited += 1;
            if visited > MAX_RUNTIME_DIRECTORIES {
                return Err(LegacyMigrationError::ResourceLimit(format!(
                    "workspace runtime contains more than {MAX_RUNTIME_DIRECTORIES} directories"
                )));
            }
            let sessions = runtime.join("sessions");
            match fs::symlink_metadata(&sessions) {
                Ok(_) => {
                    reject_linked_directory(&sessions)?;
                    found.push(sessions);
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(io_error(&sessions, error)),
            }
        }
    }
    // SSH mirrors encode a variable number of POSIX remote path components.
    let remote = home_root.join("remote_ssh");
    if remote.exists() {
        find_session_roots_recursive(&remote, 0, &mut visited, &mut found)?;
    }
    found.sort();
    Ok(found)
}

fn find_session_roots_recursive(
    directory: &Path,
    depth: usize,
    visited: &mut usize,
    found: &mut Vec<PathBuf>,
) -> LegacyMigrationResult<()> {
    if depth > MAX_RUNTIME_DEPTH {
        return Err(LegacyMigrationError::ResourceLimit(format!(
            "workspace runtime depth exceeds {MAX_RUNTIME_DEPTH}: {}",
            directory.display()
        )));
    }
    *visited = visited.saturating_add(1);
    if *visited > MAX_RUNTIME_DIRECTORIES {
        return Err(LegacyMigrationError::ResourceLimit(format!(
            "workspace runtime contains more than {MAX_RUNTIME_DIRECTORIES} directories"
        )));
    }
    reject_linked_directory(directory)?;
    if directory.file_name().and_then(|value| value.to_str()) == Some("sessions") {
        found.push(directory.to_path_buf());
        return Ok(());
    }
    for child in child_directories(directory)? {
        find_session_roots_recursive(&child, depth + 1, visited, found)?;
    }
    Ok(())
}

fn child_directories(directory: &Path) -> LegacyMigrationResult<Vec<PathBuf>> {
    let mut paths = Vec::new();
    for entry in read_dir_sorted(directory)? {
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(|error| io_error(&path, error))?;
        if metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
            return Err(LegacyMigrationError::LinkedPath(path));
        }
        if metadata.is_dir() {
            paths.push(path);
        }
    }
    Ok(paths)
}

fn read_dir_sorted(directory: &Path) -> LegacyMigrationResult<Vec<fs::DirEntry>> {
    let mut entries = fs::read_dir(directory)
        .map_err(|error| io_error(directory, error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| io_error(directory, error))?;
    entries.sort_by_key(|entry| entry.file_name());
    Ok(entries)
}

fn reject_linked_directory(path: &Path) -> LegacyMigrationResult<()> {
    let metadata = fs::symlink_metadata(path).map_err(|error| io_error(path, error))?;
    if metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
        return Err(LegacyMigrationError::LinkedPath(path.to_path_buf()));
    }
    if !metadata.is_dir() {
        return Err(LegacyMigrationError::UnsupportedSource(format!(
            "expected a directory at {}",
            path.display()
        )));
    }
    Ok(())
}

#[cfg(windows)]
fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x0400 != 0
}

#[cfg(not(windows))]
fn is_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

fn merge_reference_list(
    target: Option<&Vec<String>>,
    source: &[String],
    id_map: &BTreeMap<String, String>,
    workspaces: &HashMap<String, WorkspaceInfo>,
) -> Vec<String> {
    let mut merged = Vec::new();
    let mut seen = HashSet::new();
    for id in target
        .into_iter()
        .flatten()
        .cloned()
        .chain(source.iter().filter_map(|id| id_map.get(id)).cloned())
    {
        if workspaces.contains_key(&id) && seen.insert(id.clone()) {
            merged.push(id);
        }
    }
    merged
}

fn expected_session_hash(
    bundle: &OfflineSessionBundle,
    auxiliary_files: &[(PathBuf, PathBuf)],
    state_bytes_override: Option<&[u8]>,
) -> LegacyMigrationResult<String> {
    let mut entries = Vec::new();
    entries.push((
        PathBuf::from("metadata.json"),
        serde_json::to_vec(&StoredSessionMetadataFile::new(bundle.metadata.clone()))
            .map_err(json_error)?,
    ));
    for turn in &bundle.turns {
        entries.push((
            PathBuf::from("turns").join(format!("turn-{:04}.json", turn.turn_index)),
            serde_json::to_vec(&StoredDialogTurnFile::new(turn.clone())).map_err(json_error)?,
        ));
    }
    for (relative, source) in auxiliary_files {
        if relative == Path::new("state.json") {
            if let Some(bytes) = state_bytes_override {
                entries.push((relative.clone(), bytes.to_vec()));
                continue;
            }
        }
        entries.push((
            relative.clone(),
            fs::read(source).map_err(|error| io_error(source, error))?,
        ));
    }
    Ok(hash_entries(entries))
}

fn expected_session_bytes(session: &PlannedSession) -> LegacyMigrationResult<u64> {
    expected_bundle_bytes(
        &session.bundle,
        &session.auxiliary_files,
        session.state_bytes_override.as_deref(),
    )
}

fn expected_bundle_bytes(
    bundle: &OfflineSessionBundle,
    auxiliary_files: &[(PathBuf, PathBuf)],
    state_bytes_override: Option<&[u8]>,
) -> LegacyMigrationResult<u64> {
    let metadata_bytes =
        serde_json::to_vec(&StoredSessionMetadataFile::new(bundle.metadata.clone()))
            .map_err(json_error)?
            .len() as u64;
    let turn_bytes = bundle.turns.iter().try_fold(0u64, |total, turn| {
        serde_json::to_vec(&StoredDialogTurnFile::new(turn.clone()))
            .map(|bytes| total.saturating_add(bytes.len() as u64))
            .map_err(json_error)
    })?;
    let auxiliary_bytes = auxiliary_files.iter().try_fold(
        0u64,
        |total, (relative, path)| -> LegacyMigrationResult<u64> {
            if relative == Path::new("state.json") {
                if let Some(bytes) = state_bytes_override {
                    return Ok(total.saturating_add(bytes.len() as u64));
                }
            }
            let bytes = fs::metadata(path)
                .map_err(|error| io_error(path, error))?
                .len();
            Ok(total.saturating_add(bytes))
        },
    )?;
    Ok(metadata_bytes
        .saturating_add(turn_bytes)
        .saturating_add(auxiliary_bytes))
}

pub(crate) fn target_wins_session_ids(
    roots: &MigrationRoots,
) -> LegacyMigrationResult<BTreeSet<String>> {
    Ok(plan_workspace_sessions(roots)?
        .sessions
        .into_iter()
        .filter(|session| session.action == SessionImportAction::TargetWins)
        .map(|session| session.bundle.metadata.session_id)
        .collect())
}

fn hash_entries(mut entries: Vec<(PathBuf, Vec<u8>)>) -> String {
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    let mut hasher = Sha256::new();
    for (relative, bytes) in entries {
        hasher.update(relative.to_string_lossy().replace('\\', "/").as_bytes());
        hasher.update([0]);
        hasher.update(bytes);
        hasher.update([0]);
    }
    format!("sha256:{}", hex::encode(hasher.finalize()))
}

fn tree_entries(root: &Path) -> LegacyMigrationResult<Vec<(PathBuf, bool)>> {
    let mut entries = Vec::new();
    openbitfun_legacy_migration::visit_directory(root, |path, directory| {
        if path != root {
            entries.push((path.to_path_buf(), directory));
        }
        Ok(())
    })?;
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(entries)
}
fn hash_tree_with_size(root: &Path) -> LegacyMigrationResult<(String, u64)> {
    use std::io::Read;
    let mut hasher = Sha256::new();
    let mut logical_bytes = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    for (path, directory) in tree_entries(root)? {
        if directory {
            continue;
        }
        let relative = path
            .strip_prefix(root)
            .map_err(|_| LegacyMigrationError::PathEscape(path.clone()))?;
        hasher.update(relative.to_string_lossy().replace('\\', "/").as_bytes());
        hasher.update([0]);
        let mut file = fs::File::open(&path).map_err(|error| io_error(&path, error))?;
        loop {
            let read = file
                .read(&mut buffer)
                .map_err(|error| io_error(&path, error))?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
            logical_bytes += read as u64;
        }
        hasher.update([0]);
    }
    Ok((
        format!("sha256:{}", hex::encode(hasher.finalize())),
        logical_bytes,
    ))
}

fn hash_tree(root: &Path) -> LegacyMigrationResult<String> {
    hash_tree_with_size(root).map(|(hash, _)| hash)
}
fn require_tree_hash(path: &Path, expected: &str) -> LegacyMigrationResult<()> {
    let actual = hash_tree(path)?;
    if actual != expected {
        return Err(LegacyMigrationError::InvalidRequest(format!(
            "Session tree hash mismatch at {}",
            path.display()
        )));
    }
    Ok(())
}

fn hash_file(path: &Path) -> LegacyMigrationResult<String> {
    fs::read(path)
        .map(|bytes| format!("sha256:{}", hex::encode(Sha256::digest(bytes))))
        .map_err(|error| io_error(path, error))
}

fn require_file_hash(path: &Path, expected: &str) -> LegacyMigrationResult<()> {
    if hash_file(path)? != expected {
        return Err(LegacyMigrationError::InvalidRequest(format!(
            "file hash mismatch at {}",
            path.display()
        )));
    }
    Ok(())
}

fn install_directory_idempotent(
    staged: &Path,
    target: &Path,
    expected_hash: &str,
    run_id: &str,
) -> LegacyMigrationResult<()> {
    if target.exists() {
        if hash_tree(target)? == expected_hash {
            return Ok(());
        }
        return Err(LegacyMigrationError::InvalidRequest(format!(
            "target changed after planning: {}",
            target.display()
        )));
    }
    let parent = target.parent().ok_or_else(|| {
        LegacyMigrationError::InvalidRequest(format!("target has no parent: {}", target.display()))
    })?;
    fs::create_dir_all(parent).map_err(|error| io_error(parent, error))?;
    let temp = parent.join(format!(
        ".migration-{}-{}",
        safe_component(run_id),
        target.file_name().unwrap_or_default().to_string_lossy()
    ));
    if temp.exists() {
        fs::remove_dir_all(&temp).map_err(|error| io_error(&temp, error))?;
    }
    let install_result = copy_tree(staged, &temp)
        .and_then(|()| fs::rename(&temp, target).map_err(|error| io_error(target, error)));
    if install_result.is_err() && temp.exists() {
        fs::remove_dir_all(&temp).map_err(|error| io_error(&temp, error))?;
    }
    install_result
}

fn install_file_idempotent(
    staged: &Path,
    target: &Path,
    expected_hash: &str,
) -> LegacyMigrationResult<()> {
    if target.exists() {
        if hash_file(target)? == expected_hash {
            return Ok(());
        }
        return Err(LegacyMigrationError::InvalidRequest(format!(
            "target changed after planning: {}",
            target.display()
        )));
    }
    let bytes = fs::read(staged).map_err(|error| io_error(staged, error))?;
    atomic_write_bytes(target, &bytes)
}

fn remove_directory_if_matches(staged: &Path, target: &Path) -> LegacyMigrationResult<()> {
    if staged.exists() && target.exists() && hash_tree(staged)? == hash_tree(target)? {
        fs::remove_dir_all(target).map_err(|error| io_error(target, error))?;
    }
    Ok(())
}

fn remove_file_if_matches(staged: &Path, target: &Path) -> LegacyMigrationResult<()> {
    if staged.exists() && target.exists() && hash_file(staged)? == hash_file(target)? {
        fs::remove_file(target).map_err(|error| io_error(target, error))?;
    }
    Ok(())
}

fn verify_planned_file_state(
    path: &Path,
    expected_exists: bool,
    expected_hash: Option<&str>,
) -> LegacyMigrationResult<()> {
    if path.exists() != expected_exists {
        return Err(LegacyMigrationError::InvalidRequest(format!(
            "target changed after planning: {}",
            path.display()
        )));
    }
    if let Some(expected_hash) = expected_hash {
        require_file_hash(path, expected_hash)?;
    }
    Ok(())
}

fn orphaned_session_relationship_count(manifest: &WorkspaceSessionsManifest) -> usize {
    let sessions = manifest
        .sessions
        .iter()
        .map(|entry| entry.session_id.as_str())
        .collect::<HashSet<_>>();
    manifest
        .sessions
        .iter()
        .filter(|entry| entry.action == SessionImportAction::Import)
        .filter_map(|entry| entry.relationship.as_ref())
        .filter_map(|relationship| relationship.parent_session_id.as_deref())
        .filter(|parent_session_id| !sessions.contains(parent_session_id))
        .count()
}

fn session_manifest_entry(session: &PlannedSession) -> SessionManifestEntry {
    SessionManifestEntry {
        runtime_relative: session
            .runtime_relative
            .to_string_lossy()
            .replace('\\', "/"),
        session_id: session.bundle.metadata.session_id.clone(),
        action: session.action,
        expected_hash: session.expected_hash.clone(),
        turn_ids: session
            .bundle
            .turns
            .iter()
            .map(|turn| turn.turn_id.clone())
            .collect(),
        relationship: session.bundle.metadata.relationship.clone(),
    }
}

fn assistant_workspace_manifest_entry(
    workspace: &PlannedAssistantWorkspace,
) -> AssistantWorkspaceManifestEntry {
    AssistantWorkspaceManifestEntry {
        relative_path: workspace.relative_path.to_string_lossy().replace('\\', "/"),
        action: workspace.action,
        expected_hash: workspace.expected_hash.clone(),
    }
}

fn imported_assistant_workspaces(
    manifest: &WorkspaceSessionsManifest,
) -> impl Iterator<Item = &AssistantWorkspaceManifestEntry> {
    manifest
        .assistant_workspaces
        .iter()
        .filter(|entry| entry.action == SessionImportAction::Import)
}

fn imported_sessions(
    manifest: &WorkspaceSessionsManifest,
) -> impl Iterator<Item = &SessionManifestEntry> {
    manifest
        .sessions
        .iter()
        .filter(|entry| entry.action == SessionImportAction::Import)
}

fn imported_runtime_events(
    manifest: &WorkspaceSessionsManifest,
) -> impl Iterator<Item = &RuntimeEventManifestEntry> {
    manifest
        .runtime_events
        .iter()
        .filter(|entry| entry.action == SessionImportAction::Import)
}

pub(crate) fn read_workspace_sessions_manifest(
    context: &DomainContext<'_>,
) -> LegacyMigrationResult<WorkspaceSessionsManifest> {
    read_bounded_json(
        &context.layout.stage_root(),
        &workspace_sessions_manifest_path(context),
    )
}

fn workspace_sessions_manifest_path(context: &DomainContext<'_>) -> PathBuf {
    stage_domain_dir(context, "workspace-sessions").join("manifest.json")
}

fn source_workspace_data_path(roots: &MigrationRoots) -> PathBuf {
    roots.legacy_user_root.join("data/workspace_data.json")
}

fn target_workspace_data_path(roots: &MigrationRoots) -> PathBuf {
    roots.target_user_root.join("data/workspace_data.json")
}

fn path_from_manifest(value: &str) -> LegacyMigrationResult<PathBuf> {
    let path = PathBuf::from(value);
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(LegacyMigrationError::PathEscape(path));
    }
    Ok(path)
}

fn file_name(path: &Path) -> LegacyMigrationResult<String> {
    path.file_name()
        .and_then(|value| value.to_str())
        .map(str::to_string)
        .ok_or_else(|| {
            LegacyMigrationError::UnsupportedSource(format!(
                "path component is not valid UTF-8: {}",
                path.display()
            ))
        })
}

fn safe_component(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect()
}

fn offline_runtime() -> LegacyMigrationResult<tokio::runtime::Runtime> {
    tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .map_err(|error| {
            LegacyMigrationError::InvalidRequest(format!(
                "failed to initialize offline Session writer: {error}"
            ))
        })
}

fn owner_error(context: &str, error: impl std::fmt::Display) -> LegacyMigrationError {
    LegacyMigrationError::InvalidRequest(format!("{context}: {error}"))
}

fn json_error(error: serde_json::Error) -> LegacyMigrationError {
    LegacyMigrationError::InvalidRequest(format!("JSON conversion failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use openbitfun_core_types::SessionExecutionTarget;

    #[test]
    fn damaged_turns_and_filename_mismatches_recover_valid_history() {
        let temp = test_tempdir("partial-turns");
        let root = temp.path();
        let session = root.join("session-1");
        fs::create_dir_all(session.join("turns")).unwrap();
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("../legacy-migration/tests/fixtures/v0.2.19/home/projects/c--fixture-workspace/sessions/session-1/turns/turn-0000.json");
        let bytes = fs::read(fixture).unwrap();
        fs::write(session.join("turns/old-name.json"), &bytes).unwrap();
        fs::write(session.join("turns/turn-0001.json"), b"broken JSON").unwrap();
        let (turns, issues) = read_session_turns(root, &session, "session-1").unwrap();
        assert_eq!(turns.len(), 1);
        assert_eq!(issues.len(), 2);
        fs::write(session.join("turns/duplicate.json"), &bytes).unwrap();
        assert_eq!(
            read_session_turns(root, &session, "session-1")
                .unwrap()
                .0
                .len(),
            1
        );
        let mut conflicting: StoredDialogTurnFile = serde_json::from_slice(&bytes).unwrap();
        conflicting.turn.turn_id = "conflicting-id".into();
        atomic_write_json(&session.join("turns/conflict.json"), &conflicting).unwrap();
        assert!(read_session_turns(root, &session, "session-1")
            .unwrap()
            .0
            .is_empty());

        assert_eq!(
            fs::read(session.join("turns/old-name.json")).unwrap(),
            bytes
        );
    }

    #[test]
    fn remote_workspace_paths_are_normalized_with_posix_semantics() {
        let mut workspace: WorkspaceInfo = serde_json::from_value(serde_json::json!({
            "id": "legacy-remote",
            "name": "Remote fixture",
            "rootPath": "\\srv\\repo\\",
            "workspaceType": "Other",
            "workspaceKind": "remote",
            "status": "Inactive",
            "languages": [],
            "openedAt": "2026-01-01T00:00:00Z",
            "lastAccessed": "2026-01-01T00:00:00Z",
            "description": null,
            "tags": [],
            "statistics": null,
            "relatedPaths": [],
            "metadata": {
                "sshHost": "fixture.example",
                "connectionId": "fixture-connection"
            }
        }))
        .unwrap();

        normalize_legacy_workspace_for_current(&mut workspace).unwrap();
        assert_eq!(workspace.root_path.to_string_lossy(), "/srv/repo");
        assert!(legacy_workspace_storage_id(&workspace)
            .unwrap()
            .starts_with("remote_"));
    }

    #[test]
    fn streamed_tree_hash_preserves_the_existing_manifest_format() {
        let temp = test_tempdir("tree-hash");
        let entries = vec![
            (PathBuf::from("z"), vec![42; 150_000]),
            (PathBuf::from("a/b"), b"hello".to_vec()),
        ];
        for (path, bytes) in &entries {
            atomic_write_bytes(&temp.path().join(path), bytes).unwrap();
        }
        let (hash, size) = hash_tree_with_size(temp.path()).unwrap();
        assert_eq!(hash, hash_entries(entries));
        assert_eq!(size, 150_005);
    }

    #[test]
    fn session_discovery_ignores_workspace_content_and_runtime_artifacts() {
        let temp = test_tempdir("session-discovery");
        let home = temp.path();
        let expected = vec![
            home.join("projects/assistant/sessions"),
            home.join("projects/local/sessions"),
            home.join("remote_ssh/host/srv/nested/repo/sessions"),
        ];
        for path in &expected {
            fs::create_dir_all(path).unwrap();
        }
        for relative in [
            "personal_assistant/workspace/build",
            "projects/local/snapshots",
            "projects/local/plugin-runtime",
        ] {
            let mut deep = home.join(relative);
            for _ in 0..=MAX_RUNTIME_DEPTH {
                deep.push("d");
            }
            // A user directory named sessions is not product Session storage.
            fs::create_dir_all(deep.join("sessions")).unwrap();
        }
        assert_eq!(find_session_roots(home).unwrap(), expected);
    }

    #[test]
    fn assistant_runtime_slug_is_stable_before_and_after_target_creation() {
        let temp = test_tempdir("assistant-slug");
        let target = temp.path().join("long-destination-component-for-hashed-runtime-slug/personal_assistant/workspace-assistant");
        let planned = assistant_session_runtime_relative(target.clone());
        fs::create_dir_all(&target).unwrap();
        assert_eq!(planned, assistant_session_runtime_relative(target));
    }

    #[test]
    fn personal_assistant_tree_and_session_paths_are_rehomed_together() {
        let temp = test_tempdir("personal-assistant");
        let roots = fixture_roots(temp.path());
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../services/legacy-migration/tests/fixtures/v0.2.19");
        copy_tree(&fixture.join("user-root"), &roots.legacy_user_root).unwrap();
        copy_tree(&fixture.join("home"), &roots.legacy_home_root).unwrap();

        let source_assistant = roots
            .legacy_home_root
            .join("personal_assistant/workspace-assistant");
        atomic_write_bytes(&source_assistant.join("IDENTITY.md"), b"Assistant identity").unwrap();
        atomic_write_bytes(
            &source_assistant.join("user-content/page.html"),
            b"<p>preserved</p>",
        )
        .unwrap();
        let target_assistant = roots
            .target_home_root
            .join("personal_assistant/workspace-assistant");

        let workspace_path = source_workspace_data_path(&roots);
        let mut workspace_data: serde_json::Value =
            serde_json::from_slice(&fs::read(&workspace_path).unwrap()).unwrap();
        // Use a native absolute path instead of the archived Windows path.
        workspace_data["workspaces"]["workspace-1"]["rootPath"] =
            serde_json::json!(roots.legacy_home_root.join("fixture-workspace"));
        workspace_data["workspaces"]["assistant-legacy"] = serde_json::json!({
            "id": "assistant-legacy",
            "name": "Personal assistant",
            "rootPath": source_assistant,
            "workspaceType": "Other",
            "workspaceKind": "assistant",
            "status": "Inactive",
            "languages": [],
            "openedAt": "2026-01-01T00:00:00Z",
            "lastAccessed": "2026-01-01T00:00:00Z",
            "description": null,
            "tags": [],
            "statistics": null,
            "relatedPaths": [],
            "metadata": { "sshHost": "localhost" }
        });
        workspace_data["recent_assistant_workspaces"] = serde_json::json!(["assistant-legacy"]);
        atomic_write_json(&workspace_path, &workspace_data).unwrap();

        let metadata_path = roots
            .legacy_home_root
            .join("projects/c--fixture-workspace/sessions/session-1/metadata.json");
        let mut metadata: StoredSessionMetadataFile =
            serde_json::from_slice(&fs::read(&metadata_path).unwrap()).unwrap();
        let source_display = source_assistant.to_string_lossy().into_owned();
        metadata.metadata.workspace_path = Some(source_display.clone());
        metadata.metadata.project_workspace_path = Some(source_display.clone());
        metadata.metadata.execution_target =
            Some(SessionExecutionTarget::local(source_display.clone()));
        atomic_write_json(&metadata_path, &metadata).unwrap();
        let session_dir = metadata_path.parent().unwrap();
        atomic_write_json(
            &session_dir.join("state.json"),
            &serde_json::json!({
                "schema_version": 1,
                "config": {
                    "workspace_path": source_display.clone(),
                    "project_workspace_path": source_display.clone(),
                    "execution_target": {
                        "kind": "local",
                        "rootPath": source_display.clone()
                    },
                    "unknown_future_field": "preserved"
                },
                "historical_tool_path": source_display.clone()
            }),
        )
        .unwrap();
        atomic_write_json(
            &session_dir.join("prompt_cache.json"),
            &serde_json::json!({
                "schema_version": 1,
                "user_context": {
                    "content": format!("Current Working Directory: {source_display}")
                }
            }),
        )
        .unwrap();

        let plan = plan_workspace_sessions(&roots).unwrap();
        assert_eq!(plan.assistant_workspaces.len(), 1);
        assert_eq!(plan.assistant_workspaces[0].source_path, source_assistant);
        let assistant = plan
            .workspace_data
            .workspaces
            .values()
            .find(|workspace| workspace.workspace_kind == WorkspaceKind::Assistant)
            .unwrap();
        assert_eq!(assistant.root_path, target_assistant);
        assert!(!plan.requires_relocation.contains(&assistant.id));

        let session = plan
            .sessions
            .iter()
            .find(|session| session.bundle.metadata.session_id == "session-1")
            .unwrap();
        let target_key = native_path_key(&target_assistant);
        assert_eq!(
            session
                .bundle
                .metadata
                .workspace_path
                .as_deref()
                .map(Path::new)
                .map(native_path_key),
            Some(target_key.clone())
        );
        assert_eq!(
            session
                .bundle
                .metadata
                .project_workspace_path
                .as_deref()
                .map(Path::new)
                .map(native_path_key),
            Some(target_key.clone())
        );
        assert_eq!(
            session
                .bundle
                .metadata
                .execution_target
                .as_ref()
                .map(|target| native_path_key(Path::new(&target.root_path))),
            Some(target_key)
        );
        assert_eq!(
            session.runtime_relative,
            assistant_session_runtime_relative(target_assistant.clone())
        );
        assert!(!session
            .auxiliary_files
            .iter()
            .any(|(relative, _)| relative == Path::new("prompt_cache.json")));
        assert!(!plan
            .skipped_paths
            .iter()
            .any(|path| path.ends_with("prompt_cache.json")));

        let migrated_state: serde_json::Value = serde_json::from_slice(
            session
                .state_bytes_override
                .as_deref()
                .expect("assistant Session state should be rewritten"),
        )
        .unwrap();
        for pointer in [
            "/config/workspace_path",
            "/config/project_workspace_path",
            "/config/execution_target/rootPath",
        ] {
            assert_eq!(
                migrated_state
                    .pointer(pointer)
                    .and_then(serde_json::Value::as_str)
                    .map(Path::new)
                    .map(native_path_key),
                Some(native_path_key(&target_assistant)),
                "{pointer} should use the migrated assistant workspace"
            );
        }
        assert_eq!(
            migrated_state
                .pointer("/config/unknown_future_field")
                .and_then(serde_json::Value::as_str),
            Some("preserved")
        );
        assert_eq!(
            migrated_state
                .pointer("/historical_tool_path")
                .and_then(serde_json::Value::as_str),
            Some(source_display.as_str())
        );
    }

    #[test]
    fn damaged_session_is_skipped_and_stale_turn_count_is_rebuilt_on_import() {
        use crate::adapters_for_groups;
        use openbitfun_legacy_migration::{
            probe_legacy_source, CancellationToken, MigrationEngine, NoCrashInjection, ProbeLimits,
        };
        use openbitfun_product_domains::legacy_migration::{
            MigrationGroupId, MigrationRunStatus, MigrationSelection,
        };
        let temp = test_tempdir("partial-sessions");
        let roots = fixture_roots(temp.path());
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../legacy-migration/tests/fixtures/v0.2.19");
        copy_tree(&fixture.join("user-root"), &roots.legacy_user_root).unwrap();
        copy_tree(&fixture.join("home"), &roots.legacy_home_root).unwrap();
        let relative = "projects/c--fixture-workspace/sessions/session-1/metadata.json";
        let metadata_path = roots.legacy_home_root.join(relative);
        let mut metadata: StoredSessionMetadataFile =
            serde_json::from_slice(&fs::read(&metadata_path).unwrap()).unwrap();
        metadata.metadata.turn_count = 0;
        atomic_write_json(&metadata_path, &metadata).unwrap();
        let original = fs::read(&metadata_path).unwrap();
        let damaged = roots
            .legacy_home_root
            .join("projects/c--fixture-workspace/sessions/broken/metadata.json");
        atomic_write_bytes(&damaged, b"invalid JSON").unwrap();
        let workspace_path = source_workspace_data_path(&roots);
        let mut registry: serde_json::Value =
            serde_json::from_slice(&fs::read(&workspace_path).unwrap()).unwrap();
        registry["workspaces"]["broken"] = serde_json::json!({"rootPath": 42});
        registry["opened_workspace_ids"] =
            serde_json::json!(["workspace-1", "workspace-1", "missing", 7]);
        atomic_write_json(&workspace_path, &registry).unwrap();
        let broken_turn = metadata_path.parent().unwrap().join("turns/turn-0001.json");
        fs::write(&broken_turn, b"invalid Turn").unwrap();
        let selection = MigrationSelection {
            groups: BTreeSet::from([MigrationGroupId::WorkspacesSessionsAndTasks]),
        };
        let source = probe_legacy_source(&roots, ProbeLimits::default())
            .unwrap()
            .unwrap();
        let engine = MigrationEngine::new(roots.clone(), adapters_for_groups(&selection)).unwrap();
        let plan = engine
            .plan(&source, selection, &CancellationToken::default())
            .unwrap();
        assert!(plan.findings.iter().any(|finding| finding.domain
            == MigrationDomainId::WorkspaceSessions
            && finding.migratable
            && finding.code == "session_items_skipped"));
        let report = engine
            .execute(&plan, &CancellationToken::default(), &NoCrashInjection)
            .unwrap();
        assert_eq!(report.status, MigrationRunStatus::CompletedWithWarnings);
        let imported: StoredSessionMetadataFile =
            serde_json::from_slice(&fs::read(roots.target_home_root.join(relative)).unwrap())
                .unwrap();
        assert_eq!(imported.metadata.turn_count, 1);
        assert!(report
            .domain_results
            .iter()
            .flat_map(|result| &result.warnings)
            .any(|warning| warning.code == "session_turns_recovered"));
        assert_eq!(fs::read(&broken_turn).unwrap(), b"invalid Turn");
        assert!(!roots
            .target_home_root
            .join("projects/c--fixture-workspace/sessions/session-1/turns/turn-0001.json")
            .exists());

        assert_eq!(fs::read(metadata_path).unwrap(), original);
        assert_eq!(fs::read(damaged).unwrap(), b"invalid JSON");
        assert!(!roots
            .target_home_root
            .join("projects/c--fixture-workspace/sessions/broken")
            .exists());
        assert!(report.domain_results.iter().any(|result| result.domain
            == MigrationDomainId::WorkspaceSessions
            && result.skipped > 0
            && !result.warnings.is_empty()));
    }

    fn fixture_roots(root: &Path) -> MigrationRoots {
        let legacy_user_root = root.join("legacy-user");
        MigrationRoots {
            legacy_skills_root: legacy_user_root.join("skills"),
            legacy_user_root,
            legacy_home_root: root.join("legacy-home"),
            legacy_ssh_root: root.join("legacy-ssh"),
            target_user_root: root.join("target-user"),
            target_home_root: root.join("target-home"),
            target_skills_root: root.join("target-skills"),
            target_ssh_root: root.join("target-ssh"),
        }
    }

    fn test_tempdir(label: &str) -> tempfile::TempDir {
        let root = std::env::var_os("OPENBITFUN_TEST_TMPDIR")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        fs::create_dir_all(&root).unwrap();
        tempfile::Builder::new()
            .prefix(&format!("openbitfun-migration-{label}-"))
            .tempdir_in(root)
            .unwrap()
    }
}

// Temporary pre-1.0 import conversion only. Existing registry IDs are opaque;
// normal catalog loading must never recompute identity from a filesystem path.
fn legacy_workspace_storage_id(
    workspace: &WorkspaceInfo,
) -> openbitfun_services_core::storage_error::StorageResult<String> {
    match workspace.workspace_kind {
        WorkspaceKind::Remote => {
            let ssh_host = workspace
                .metadata
                .get("sshHost")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    unsupported_workspace_persistence(format!(
                        "remote workspace '{}' is missing sshHost",
                        workspace.id
                    ))
                })?;
            workspace.remote_ssh_connection_id().ok_or_else(|| {
                unsupported_workspace_persistence(format!(
                    "remote workspace '{}' is missing connectionId",
                    workspace.id
                ))
            })?;

            let stored_root = workspace.root_path.to_string_lossy().replace('\\', "/");
            let normalized_root = normalize_remote_workspace_path(&stored_root);
            if !normalized_root.starts_with('/') {
                return Err(unsupported_workspace_persistence(format!(
                    "remote workspace '{}' does not use an absolute POSIX root",
                    workspace.id
                )));
            }
            if stored_root != normalized_root {
                return Err(unsupported_workspace_persistence(format!(
                    "remote workspace '{}' rootPath is not normalized",
                    workspace.id
                )));
            }
            Ok(remote_workspace_stable_id(ssh_host, &normalized_root))
        }
        WorkspaceKind::Normal | WorkspaceKind::Assistant => {
            let ssh_host = workspace
                .metadata
                .get("sshHost")
                .and_then(|value| value.as_str())
                .map(str::trim);
            if ssh_host != Some(LOCAL_WORKSPACE_SSH_HOST) {
                return Err(unsupported_workspace_persistence(format!(
                    "local workspace '{}' does not declare sshHost=localhost",
                    workspace.id
                )));
            }
            expected_persisted_local_workspace_id(&workspace.root_path).map_err(|error| {
                unsupported_workspace_persistence(format!(
                    "local workspace '{}' is not canonical: {error}",
                    workspace.id
                ))
            })
        }
    }
}

fn expected_persisted_local_workspace_id(root_path: &Path) -> Result<String, String> {
    if !root_path.is_absolute() {
        return Err(format!(
            "local workspace rootPath is not absolute: {}",
            root_path.display()
        ));
    }

    let normalized_root = if root_path.exists() {
        let (canonical_root, normalized_root) = canonicalize_local_workspace_root(root_path)?;
        if canonical_root != root_path {
            return Err(format!(
                "local workspace rootPath is not canonical: {}",
                root_path.display()
            ));
        }
        normalized_root
    } else {
        root_path.to_string_lossy().replace('\\', "/")
    };

    Ok(local_workspace_stable_storage_id(&normalized_root))
}
