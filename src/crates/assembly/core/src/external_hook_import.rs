//! Explicit local plan/apply lifecycle for imported command Hooks.

use crate::external_hooks::service_for;
use crate::infrastructure::{try_get_path_manager_arc, PathManager};
use futures::future::join_all;
use openbitfun_product_domains::external_hook_import::{
    ExternalHookImportApplyOutcomeV1, ExternalHookImportApplyRequestV1,
    ExternalHookImportApplyResultV1, ExternalHookImportDispositionV1, ExternalHookImportHandlerV1,
    ExternalHookImportMutationRequestV1, ExternalHookImportMutationV1, ExternalHookImportPlanV1,
    ExternalHookImportSkippedV1, ExternalHookImportSnapshotV1, ImportedHookSourceSnapshotV1,
    ImportedHookSourceStateV1, PreparedExternalHookImport, EXTERNAL_HOOK_IMPORT_SCHEMA_V1,
};
use openbitfun_product_domains::external_sources::{
    ExternalSourceAssetKind, ExternalSourceDiagnostic, ExternalSourceOperationError,
    ExternalSourceOperationErrorCode, ExternalSourceOperationResult, ExternalSourceProviderError,
    ExternalSourceScope, SourceKey,
};
use openbitfun_services_integrations::hook_import::{
    HookImportApply, HookImportRecord, HookImportStore, HookImportStoreError,
    HookImportStoreSnapshot, HookImportWrite,
};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};

const MAX_CACHED_IMPORT_STORES: usize = 64;

struct CachedImportStore {
    store: Arc<HookImportStore>,
    last_used: u64,
}

struct StoreSet {
    user: Arc<HookImportStore>,
    workspace: Option<Arc<HookImportStore>>,
    workspace_identity: String,
}

struct PreparedPlan {
    plan: ExternalHookImportPlanV1,
    prepared: PreparedExternalHookImport,
    hooks_json: Option<Vec<u8>>,
    store: Arc<HookImportStore>,
    target_generation: u64,
}

fn store_cache() -> &'static tokio::sync::Mutex<BTreeMap<PathBuf, CachedImportStore>> {
    static CACHE: OnceLock<tokio::sync::Mutex<BTreeMap<PathBuf, CachedImportStore>>> =
        OnceLock::new();
    CACHE.get_or_init(|| tokio::sync::Mutex::new(BTreeMap::new()))
}

fn next_store_tick() -> u64 {
    static TICK: AtomicU64 = AtomicU64::new(1);
    TICK.fetch_add(1, Ordering::Relaxed)
}

async fn store_for(
    root: PathBuf,
    scope: ExternalSourceScope,
) -> ExternalSourceOperationResult<Arc<HookImportStore>> {
    {
        let mut cache = store_cache().lock().await;
        if let Some(cached) = cache.get_mut(&root) {
            cached.last_used = next_store_tick();
            return Ok(Arc::clone(&cached.store));
        }
    }
    let store = Arc::new(
        HookImportStore::open(root.clone(), scope)
            .await
            .map_err(map_store_error)?,
    );
    let mut cache = store_cache().lock().await;
    if let Some(cached) = cache.get_mut(&root) {
        cached.last_used = next_store_tick();
        return Ok(Arc::clone(&cached.store));
    }
    if cache.len() >= MAX_CACHED_IMPORT_STORES {
        if let Some(oldest) = cache
            .iter()
            .min_by_key(|(_, cached)| cached.last_used)
            .map(|(root, _)| root.clone())
        {
            cache.remove(&oldest);
        }
    }
    cache.insert(
        root,
        CachedImportStore {
            store: Arc::clone(&store),
            last_used: next_store_tick(),
        },
    );
    Ok(store)
}

async fn stores_for(workspace: Option<&str>) -> ExternalSourceOperationResult<StoreSet> {
    let workspace_id = workspace;
    let workspace = crate::external_hooks::local_workspace_root(workspace_id).await?;
    let path_manager = try_get_path_manager_arc().map_err(|error| {
        ExternalSourceOperationError::new(
            ExternalSourceOperationErrorCode::Internal,
            error.to_string(),
            false,
        )
    })?;
    let user = store_for(
        path_manager.user_data_dir().join("hook-imports"),
        ExternalSourceScope::UserGlobal,
    )
    .await?;
    let workspace_store = match workspace.as_deref() {
        Some(workspace) => Some(
            store_for(
                path_manager
                    .project_runtime_root(workspace)
                    .join("hook-imports")
                    .join(PathManager::native_path_digest(workspace)),
                ExternalSourceScope::Project,
            )
            .await?,
        ),
        None => None,
    };
    Ok(StoreSet {
        user,
        workspace: workspace_store,
        workspace_identity: workspace_id
            .map(str::to_owned)
            .unwrap_or_else(|| "none".to_string()),
    })
}

pub async fn external_hook_import_snapshot(
    workspace: Option<&str>,
    refresh_updates: bool,
) -> ExternalSourceOperationResult<ExternalHookImportSnapshotV1> {
    let catalog_service = service_for(workspace).await?;
    let catalog = catalog_service.snapshot_or_refresh(refresh_updates).await?;
    let stores = stores_for(workspace).await?;
    let user = stores.user.snapshot().await.map_err(map_store_error)?;
    let workspace_snapshot = match &stores.workspace {
        Some(store) => Some(store.snapshot().await.map_err(map_store_error)?),
        None => None,
    };
    let revision = combined_revision(
        &stores.workspace_identity,
        &user,
        workspace_snapshot.as_ref(),
    );
    let mut diagnostics = Vec::new();
    append_corrupt_diagnostic(&mut diagnostics, ExternalSourceScope::UserGlobal, &user);
    if let Some(snapshot) = &workspace_snapshot {
        append_corrupt_diagnostic(&mut diagnostics, ExternalSourceScope::Project, snapshot);
    }
    let mut imports = join_all(
        user.imports
            .iter()
            .chain(
                workspace_snapshot
                    .iter()
                    .flat_map(|snapshot| &snapshot.imports),
            )
            .map(|record| async {
                let state =
                    import_state(record, &catalog.sources, &catalog_service, refresh_updates).await;
                ImportedHookSourceSnapshotV1 {
                    import_id: record.import_id.clone(),
                    source: record.source.clone(),
                    enabled: record.enabled,
                    behavior_version: record.behavior_version.clone(),
                    state,
                }
            }),
    )
    .await;
    imports.sort_by(|left, right| left.import_id.cmp(&right.import_id));
    Ok(ExternalHookImportSnapshotV1 {
        schema_version: EXTERNAL_HOOK_IMPORT_SCHEMA_V1,
        revision,
        catalog,
        imports,
        diagnostics,
    })
}

pub async fn plan_external_hook_import(
    workspace: Option<&str>,
    source: SourceKey,
) -> ExternalSourceOperationResult<ExternalHookImportPlanV1> {
    Ok(build_plan(workspace, source).await?.plan)
}

pub async fn apply_external_hook_import(
    workspace: Option<&str>,
    request: ExternalHookImportApplyRequestV1,
) -> ExternalSourceOperationResult<ExternalHookImportApplyResultV1> {
    if request.schema_version != EXTERNAL_HOOK_IMPORT_SCHEMA_V1 {
        return Err(invalid_request("Unsupported Hook import request schema"));
    }
    let prepared_plan = build_plan(workspace, request.source).await?;
    if prepared_plan.plan.plan_fingerprint != request.plan_fingerprint {
        return Ok(ExternalHookImportApplyResultV1 {
            schema_version: EXTERNAL_HOOK_IMPORT_SCHEMA_V1,
            outcome: ExternalHookImportApplyOutcomeV1::Stale {
                refreshed_plan: prepared_plan.plan,
            },
        });
    }
    let hooks_json = prepared_plan
        .hooks_json
        .ok_or_else(|| invalid_request("This Hook source has no compatible command handlers"))?;
    let write = HookImportWrite {
        source: prepared_plan.prepared.source,
        behavior_version: prepared_plan.prepared.behavior_version,
        hooks_json,
        assets: prepared_plan.prepared.assets,
    };
    let applied = prepared_plan
        .store
        .apply(prepared_plan.target_generation, write)
        .await
        .map_err(map_store_error)?;
    let snapshot = external_hook_import_snapshot(workspace, false).await?;
    let outcome = match applied {
        HookImportApply::Applied => ExternalHookImportApplyOutcomeV1::Applied { snapshot },
        HookImportApply::Unchanged => ExternalHookImportApplyOutcomeV1::Unchanged { snapshot },
    };
    Ok(ExternalHookImportApplyResultV1 {
        schema_version: EXTERNAL_HOOK_IMPORT_SCHEMA_V1,
        outcome,
    })
}

pub async fn mutate_external_hook_import(
    workspace: Option<&str>,
    request: ExternalHookImportMutationRequestV1,
) -> ExternalSourceOperationResult<ExternalHookImportSnapshotV1> {
    if request.schema_version != EXTERNAL_HOOK_IMPORT_SCHEMA_V1 {
        return Err(invalid_request("Unsupported Hook import mutation schema"));
    }
    let stores = stores_for(workspace).await?;
    let user = stores.user.snapshot().await.map_err(map_store_error)?;
    let workspace_snapshot = match &stores.workspace {
        Some(store) => Some(store.snapshot().await.map_err(map_store_error)?),
        None => None,
    };
    if request.expected_revision
        != combined_revision(
            &stores.workspace_identity,
            &user,
            workspace_snapshot.as_ref(),
        )
    {
        return Err(ExternalSourceOperationError::new(
            ExternalSourceOperationErrorCode::StaleRevision,
            "Hook import state changed; refresh before retrying",
            true,
        ));
    }
    match request.action {
        ExternalHookImportMutationV1::SetEnabled { import_id, enabled } => {
            let (store, generation) =
                locate_import_store(&stores, &user, workspace_snapshot.as_ref(), &import_id)?;
            store
                .set_enabled(generation, &import_id, enabled)
                .await
                .map_err(map_store_error)?;
        }
        ExternalHookImportMutationV1::Remove { import_id } => {
            let (store, generation) =
                locate_import_store(&stores, &user, workspace_snapshot.as_ref(), &import_id)?;
            store
                .remove(generation, &import_id)
                .await
                .map_err(map_store_error)?;
        }
        ExternalHookImportMutationV1::ResetCorruptStore { scope } => {
            let store = match scope {
                ExternalSourceScope::UserGlobal => Arc::clone(&stores.user),
                ExternalSourceScope::Project | ExternalSourceScope::WorkspaceLocal => {
                    stores.workspace.as_ref().cloned().ok_or_else(|| {
                        invalid_request("No workspace Hook import store is selected")
                    })?
                }
                _ => return Err(invalid_request("Remote Hook import stores are unsupported")),
            };
            store.reset_corrupt().await.map_err(map_store_error)?;
        }
    }
    external_hook_import_snapshot(workspace, false).await
}

pub(crate) async fn imported_hook_generation(
    workspace: Option<&str>,
) -> ExternalSourceOperationResult<u64> {
    let stores = stores_for(workspace).await?;
    let user_snapshot = stores.user.snapshot().await.map_err(map_store_error)?;
    let workspace_snapshot = match &stores.workspace {
        Some(store) => Some(store.snapshot().await.map_err(map_store_error)?),
        None => None,
    };
    Ok(generation_key(
        &stores.workspace_identity,
        &user_snapshot,
        workspace_snapshot.as_ref(),
    ))
}

pub(crate) async fn enabled_imported_hook_layers(
    workspace: Option<&str>,
) -> ExternalSourceOperationResult<
    Vec<openbitfun_agent_runtime::native_hooks::AgentHookSettingsLayer>,
> {
    let stores = stores_for(workspace).await?;
    let mut layers = stores
        .user
        .enabled_layers()
        .await
        .map_err(map_store_error)?;
    if let Some(store) = &stores.workspace {
        layers.extend(store.enabled_layers().await.map_err(map_store_error)?);
    }
    Ok(layers)
}

async fn build_plan(
    workspace: Option<&str>,
    source_key: SourceKey,
) -> ExternalSourceOperationResult<PreparedPlan> {
    let catalog_service = service_for(workspace).await?;
    let catalog = catalog_service.snapshot_or_refresh(false).await?;
    let source = catalog
        .sources
        .iter()
        .find(|source| source.key == source_key)
        .cloned()
        .ok_or_else(|| not_found("The selected Hook source is not in the current catalog"))?;
    let prepared = catalog_service
        .prepare_import(source.key.clone(), source.content_version.clone())
        .await
        .map_err(map_provider_error)?;
    let stores = stores_for(workspace).await?;
    let store = target_store(&stores, prepared.source.scope)?;
    let target = store.snapshot().await.map_err(map_store_error)?;
    let bundle_root = store.planned_bundle_path(&prepared.source.key, &prepared.behavior_version);
    let handlers = prepared
        .handlers
        .iter()
        .map(|handler| handler.public_review_at(&bundle_root))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| invalid_request(&error.to_string()))?;
    let import_id = HookImportStore::stable_import_id(&prepared.source.key);
    let disposition = if handlers.is_empty() {
        ExternalHookImportDispositionV1::Unavailable
    } else {
        match target
            .imports
            .iter()
            .find(|record| record.import_id == import_id)
        {
            None => ExternalHookImportDispositionV1::Import,
            Some(record) if record.behavior_version == prepared.behavior_version => {
                ExternalHookImportDispositionV1::Unchanged
            }
            Some(_) => ExternalHookImportDispositionV1::Update,
        }
    };
    let fingerprint = plan_fingerprint(
        &prepared.source.key,
        &prepared.source.content_version,
        &prepared.behavior_version,
        &handlers,
        &prepared.skipped,
        target.generation,
    );
    let hooks_json = (!handlers.is_empty())
        .then(|| native_hook_document(&handlers))
        .transpose()?;
    let plan = ExternalHookImportPlanV1 {
        schema_version: EXTERNAL_HOOK_IMPORT_SCHEMA_V1,
        source: prepared.source.clone(),
        disposition,
        behavior_version: prepared.behavior_version.clone(),
        handlers,
        skipped: prepared.skipped.clone(),
        plan_fingerprint: fingerprint,
    };
    plan.validate()
        .map_err(|error| invalid_request(&error.to_string()))?;
    Ok(PreparedPlan {
        plan,
        prepared,
        hooks_json,
        store,
        target_generation: target.generation,
    })
}

fn native_hook_document(
    handlers: &[ExternalHookImportHandlerV1],
) -> ExternalSourceOperationResult<Vec<u8>> {
    let mut events = BTreeMap::<String, Vec<Value>>::new();
    for handler in handlers {
        let mut native_handler = Map::new();
        native_handler.insert("type".to_string(), Value::String("command".to_string()));
        native_handler.insert(
            "command".to_string(),
            Value::String(handler.command.clone()),
        );
        if let Some(command) = &handler.command_windows {
            native_handler.insert("commandWindows".to_string(), Value::String(command.clone()));
        }
        if let Some(timeout) = handler.timeout_seconds {
            native_handler.insert("timeout".to_string(), Value::from(timeout));
        }
        if let Some(status) = &handler.status_message {
            native_handler.insert("statusMessage".to_string(), Value::String(status.clone()));
        }
        let mut group = Map::new();
        if let Some(matcher) = &handler.matcher {
            group.insert("matcher".to_string(), Value::String(matcher.clone()));
        }
        group.insert(
            "hooks".to_string(),
            Value::Array(vec![Value::Object(native_handler)]),
        );
        events
            .entry(handler.event.clone())
            .or_default()
            .push(Value::Object(group));
    }
    serde_json::to_vec(&serde_json::json!({ "hooks": events })).map_err(|error| {
        ExternalSourceOperationError::new(
            ExternalSourceOperationErrorCode::Internal,
            format!("Failed to build native Hook document: {error}"),
            false,
        )
    })
}

fn plan_fingerprint(
    source: &SourceKey,
    catalog_content_version: &str,
    behavior_version: &str,
    handlers: &[ExternalHookImportHandlerV1],
    skipped: &[ExternalHookImportSkippedV1],
    target_generation: u64,
) -> String {
    let mut hasher = Sha256::new();
    hash_part(&mut hasher, source.stable_key().as_bytes());
    hash_part(&mut hasher, catalog_content_version.as_bytes());
    hash_part(&mut hasher, behavior_version.as_bytes());
    hash_part(
        &mut hasher,
        &serde_json::to_vec(handlers).unwrap_or_default(),
    );
    hash_part(
        &mut hasher,
        &serde_json::to_vec(skipped).unwrap_or_default(),
    );
    hash_part(&mut hasher, &target_generation.to_be_bytes());
    format!("sha256:{}", hex::encode(hasher.finalize()))
}

fn combined_revision(
    workspace_identity: &str,
    user: &HookImportStoreSnapshot,
    workspace: Option<&HookImportStoreSnapshot>,
) -> String {
    let mut hasher = Sha256::new();
    hash_part(&mut hasher, workspace_identity.as_bytes());
    hash_snapshot(&mut hasher, user);
    if let Some(workspace) = workspace {
        hash_snapshot(&mut hasher, workspace);
    } else {
        hash_part(&mut hasher, b"no-workspace-store");
    }
    format!("sha256:{}", hex::encode(hasher.finalize()))
}

fn generation_key(
    workspace_identity: &str,
    user: &HookImportStoreSnapshot,
    workspace: Option<&HookImportStoreSnapshot>,
) -> u64 {
    let revision = combined_revision(workspace_identity, user, workspace);
    u64::from_be_bytes(
        Sha256::digest(revision.as_bytes())[..8]
            .try_into()
            .expect("SHA-256 prefix length is fixed"),
    )
}

fn hash_snapshot(hasher: &mut Sha256, snapshot: &HookImportStoreSnapshot) {
    hash_part(hasher, &snapshot.generation.to_be_bytes());
    hash_part(
        hasher,
        snapshot
            .corrupt_marker
            .as_deref()
            .unwrap_or("ready")
            .as_bytes(),
    );
}

fn hash_part(hasher: &mut Sha256, value: &[u8]) {
    hasher.update((value.len() as u64).to_be_bytes());
    hasher.update(value);
}

async fn import_state(
    record: &HookImportRecord,
    catalog_sources: &[openbitfun_product_domains::external_hook_catalog::ExternalHookSource],
    catalog_service: &Arc<crate::external_hooks::WorkspaceExternalHookCatalogService>,
    refresh_updates: bool,
) -> ImportedHookSourceStateV1 {
    if !record.bundle_is_valid() {
        return ImportedHookSourceStateV1::BundleMissing;
    }
    let Some(source) = catalog_sources
        .iter()
        .find(|source| source.key == record.source.key)
    else {
        return ImportedHookSourceStateV1::SourceMissing;
    };
    if !refresh_updates {
        return ImportedHookSourceStateV1::Current;
    }
    match catalog_service
        .prepare_import(source.key.clone(), source.content_version.clone())
        .await
    {
        Ok(prepared) if prepared.behavior_version != record.behavior_version => {
            ImportedHookSourceStateV1::UpdateAvailable
        }
        Ok(_) => ImportedHookSourceStateV1::Current,
        Err(_) => ImportedHookSourceStateV1::UpdateCheckFailed,
    }
}

fn locate_import_store(
    stores: &StoreSet,
    user: &HookImportStoreSnapshot,
    workspace: Option<&HookImportStoreSnapshot>,
    import_id: &str,
) -> ExternalSourceOperationResult<(Arc<HookImportStore>, u64)> {
    if user
        .imports
        .iter()
        .any(|record| record.import_id == import_id)
    {
        return Ok((Arc::clone(&stores.user), user.generation));
    }
    if let (Some(store), Some(snapshot)) = (&stores.workspace, workspace) {
        if snapshot
            .imports
            .iter()
            .any(|record| record.import_id == import_id)
        {
            return Ok((Arc::clone(store), snapshot.generation));
        }
    }
    Err(not_found("The selected Hook import does not exist"))
}

fn target_store(
    stores: &StoreSet,
    scope: ExternalSourceScope,
) -> ExternalSourceOperationResult<Arc<HookImportStore>> {
    match scope {
        ExternalSourceScope::UserGlobal => Ok(Arc::clone(&stores.user)),
        ExternalSourceScope::Project | ExternalSourceScope::WorkspaceLocal => stores
            .workspace
            .as_ref()
            .cloned()
            .ok_or_else(|| invalid_request("A workspace is required for this Hook source")),
        _ => Err(invalid_request(
            "Remote Hook sources cannot be imported locally",
        )),
    }
}

fn append_corrupt_diagnostic(
    diagnostics: &mut Vec<ExternalSourceDiagnostic>,
    scope: ExternalSourceScope,
    snapshot: &HookImportStoreSnapshot,
) {
    if snapshot.corrupt_marker.is_some() {
        let scope_key = match scope {
            ExternalSourceScope::UserGlobal => "user_global",
            ExternalSourceScope::Project | ExternalSourceScope::WorkspaceLocal => "project",
            _ => "unsupported",
        };
        diagnostics.push(
            ExternalSourceDiagnostic::error(
                format!("external_hook.import_store_corrupt.{scope_key}"),
                format!("The {scope:?} Hook import index is invalid; imported Hooks are disabled"),
                None,
            )
            .with_asset_kind(ExternalSourceAssetKind::Hook),
        );
    }
}

fn map_store_error(error: HookImportStoreError) -> ExternalSourceOperationError {
    let (code, retryable) = match error {
        HookImportStoreError::StaleGeneration => {
            (ExternalSourceOperationErrorCode::StaleRevision, true)
        }
        HookImportStoreError::InvalidInput(_) => {
            (ExternalSourceOperationErrorCode::InvalidRequest, false)
        }
        HookImportStoreError::Corrupt => (ExternalSourceOperationErrorCode::Unavailable, false),
        HookImportStoreError::Io(_) => (ExternalSourceOperationErrorCode::Internal, true),
    };
    ExternalSourceOperationError::new(code, error.to_string(), retryable)
}

fn map_provider_error(error: ExternalSourceProviderError) -> ExternalSourceOperationError {
    let code = if error.code.ends_with("unsupported") || error.code.ends_with("import_unsupported")
    {
        ExternalSourceOperationErrorCode::Unsupported
    } else if error.code.ends_with("stale") {
        ExternalSourceOperationErrorCode::StaleRevision
    } else {
        ExternalSourceOperationErrorCode::Unavailable
    };
    ExternalSourceOperationError::new(code, error.message, error.transient)
}

fn invalid_request(detail: &str) -> ExternalSourceOperationError {
    ExternalSourceOperationError::new(
        ExternalSourceOperationErrorCode::InvalidRequest,
        detail,
        false,
    )
}

fn not_found(detail: &str) -> ExternalSourceOperationError {
    ExternalSourceOperationError::new(ExternalSourceOperationErrorCode::NotFound, detail, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use openbitfun_agent_runtime::native_hooks::{
        AgentHookEvent, AgentHookScope, AgentHookSettings, AgentHookSettingsLayer,
    };
    use openbitfun_product_domains::external_hook_import::{
        ExternalHookImportHandlerV1, ExternalHookImportSkippedV1,
    };

    fn handler(command: &str) -> ExternalHookImportHandlerV1 {
        ExternalHookImportHandlerV1 {
            stable_key: "hook-one".to_string(),
            event: "PreToolUse".to_string(),
            matcher: Some("Bash".to_string()),
            command: command.to_string(),
            command_windows: Some(format!("win-{command}")),
            timeout_seconds: Some(17),
            status_message: Some("Checking".to_string()),
            dependencies: Vec::new(),
        }
    }

    #[test]
    fn native_document_is_accepted_by_the_existing_runtime_parser() {
        let bytes = native_hook_document(&[handler("check")]).unwrap();
        let (settings, issues) = AgentHookSettings::from_layers(&[AgentHookSettingsLayer {
            scope: AgentHookScope::User,
            source: "test".to_string(),
            bytes,
        }]);
        assert!(issues.is_empty());
        let rule = &settings.rules_for(AgentHookEvent::PreToolUse)[0];
        assert_eq!(rule.handlers[0].command, "check");
        assert_eq!(
            rule.handlers[0].command_windows.as_deref(),
            Some("win-check")
        );
    }

    #[test]
    fn plan_fingerprint_fences_commands_catalog_and_target_generation() {
        let source_key = SourceKey::new("codex.hooks", "user-hooks-json").unwrap();
        let skipped = vec![ExternalHookImportSkippedV1 {
            reason_code: "unsupported_event".to_string(),
            count: 1,
        }];
        let first = plan_fingerprint(
            &source_key,
            "catalog",
            "behavior",
            &[handler("one")],
            &skipped,
            1,
        );
        assert_ne!(
            first,
            plan_fingerprint(
                &source_key,
                "catalog",
                "behavior",
                &[handler("two")],
                &skipped,
                1
            )
        );
        assert_ne!(
            first,
            plan_fingerprint(
                &source_key,
                "catalog-2",
                "behavior",
                &[handler("one")],
                &skipped,
                1
            )
        );
        assert_ne!(
            first,
            plan_fingerprint(
                &source_key,
                "catalog",
                "behavior",
                &[handler("one")],
                &skipped,
                2
            )
        );
    }
}
