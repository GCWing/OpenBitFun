//! MiniApp manager: CRUD, version management, compile on save.

use crate::miniapp::compiler::{
    compile_market_with_request, compile_with_request, MiniAppCompileRequest,
};
use crate::miniapp::permission_policy::{
    resolve_policy_with_request, MiniAppPermissionPolicyRequest,
};
use crate::miniapp::storage::MiniAppStorage;
use crate::miniapp::types::{
    MiniApp, MiniAppAiContext, MiniAppMeta, MiniAppPermissions, MiniAppSource,
};
use crate::product_domain_runtime::CoreProductDomainRuntime;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use chrono::Utc;
use openbitfun_product_domains::miniapp::customization::{
    MiniAppCustomizationBaseline, MiniAppCustomizationMetadata, MiniAppPermissionDiff,
};
use openbitfun_product_domains::miniapp::draft::MiniAppDraft;
use openbitfun_product_domains::miniapp::lifecycle::{
    build_worker_revision, MiniAppCreateInput, MiniAppUpdatePatch,
};
use openbitfun_product_domains::miniapp::market::{InstalledMarketOrigin, MarketPackageMeta};
use openbitfun_product_domains::miniapp::ports::{
    MiniAppCompilePort, MiniAppImportFromPathRequest, MiniAppPortError, MiniAppPortErrorKind,
    MiniAppPortFuture, MiniAppRuntimeFacade,
};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use tokio::sync::RwLock;
use uuid::Uuid;

static GLOBAL_MINIAPP_MANAGER: OnceLock<Arc<MiniAppManager>> = OnceLock::new();

/// Initialize the global MiniAppManager (called once at startup from Tauri app_state).
pub fn initialize_global_miniapp_manager(manager: Arc<MiniAppManager>) {
    let _ = GLOBAL_MINIAPP_MANAGER.set(manager);
}

/// Get the global MiniAppManager, returning None if not initialized.
pub fn try_get_global_miniapp_manager() -> Option<Arc<MiniAppManager>> {
    GLOBAL_MINIAPP_MANAGER.get().cloned()
}

/// MiniApp manager: create, read, update, delete, list, compile, rollback.
pub struct MiniAppManager {
    storage: MiniAppStorage,
    path_manager: Arc<crate::infrastructure::PathManager>,
    /// User-granted paths per app (for resolve_policy).
    granted_paths: RwLock<HashMap<String, Vec<PathBuf>>>,
}

impl MiniAppManager {
    pub fn new(path_manager: Arc<crate::infrastructure::PathManager>) -> Self {
        let storage = MiniAppStorage::new(path_manager.clone());
        Self {
            storage,
            path_manager,
            granted_paths: RwLock::new(HashMap::new()),
        }
    }

    pub fn build_worker_revision(&self, app: &MiniApp, policy_json: &str) -> String {
        build_worker_revision(app, policy_json)
    }

    fn runtime_facade(&self) -> MiniAppRuntimeFacade<'_> {
        CoreProductDomainRuntime::miniapp_runtime_facade(&self.storage)
    }

    pub fn compile_source(
        &self,
        app_id: &str,
        source: &MiniAppSource,
        permissions: &MiniAppPermissions,
        appearance_mode: &str,
        workspace_root: Option<&Path>,
    ) -> OpenBitFunResult<String> {
        let app_data_dir = self.path_manager.miniapp_dir(app_id);
        let request = MiniAppCompileRequest::from_paths(
            app_id,
            &app_data_dir,
            workspace_root,
            appearance_mode,
        );
        compile_with_request(source, permissions, &request)
    }

    pub fn compile_market_source(
        &self,
        app_id: &str,
        source: &MiniAppSource,
        permissions: &MiniAppPermissions,
        theme: &str,
        workspace_root: Option<&Path>,
    ) -> OpenBitFunResult<String> {
        let app_data_dir = self.path_manager.miniapp_dir(app_id);
        let request =
            MiniAppCompileRequest::from_paths(app_id, &app_data_dir, workspace_root, theme);
        compile_market_with_request(source, permissions, &request)
    }

    fn compile_source_with_app_data_dir(
        &self,
        app_id: &str,
        app_data_dir: &Path,
        source: &MiniAppSource,
        permissions: &MiniAppPermissions,
        appearance_mode: &str,
        workspace_root: Option<&Path>,
    ) -> OpenBitFunResult<String> {
        let request = MiniAppCompileRequest::from_paths(
            app_id,
            app_data_dir,
            workspace_root,
            appearance_mode,
        );
        compile_with_request(source, permissions, &request)
    }

    pub async fn uses_market_strict_runtime(&self, app_id: &str) -> bool {
        self.storage
            .load_meta(app_id)
            .await
            .ok()
            .is_some_and(|meta| {
                matches!(
                    meta.runtime_profile,
                    openbitfun_product_domains::miniapp::types::MiniAppRuntimeProfile::MarketStrict
                )
            })
    }

    /// List all MiniApp metadata.
    pub async fn list(&self) -> OpenBitFunResult<Vec<MiniAppMeta>> {
        self.runtime_facade()
            .list_metadata()
            .await
            .map_err(map_miniapp_port_error)
    }

    /// Get full MiniApp by id.
    pub async fn get(&self, app_id: &str) -> OpenBitFunResult<MiniApp> {
        self.runtime_facade()
            .load_app_ensuring_runtime_state(app_id.to_string())
            .await
            .map_err(map_miniapp_port_error)
    }

    /// Get persisted metadata without normalizing runtime state.
    ///
    /// Agent-side finalization uses this raw baseline before source files are
    /// synchronized, so legacy/runtime repair cannot hide a direct file edit.
    pub async fn get_meta(&self, app_id: &str) -> OpenBitFunResult<MiniAppMeta> {
        self.storage.load_meta(app_id).await
    }

    /// Create a new MiniApp (generates id, sets created_at/updated_at, compiles).
    #[allow(clippy::too_many_arguments)]
    pub async fn create(
        &self,
        name: String,
        description: String,
        icon: String,
        category: String,
        tags: Vec<String>,
        source: MiniAppSource,
        permissions: MiniAppPermissions,
        ai_context: Option<MiniAppAiContext>,
        workspace_root: Option<&Path>,
    ) -> OpenBitFunResult<MiniApp> {
        self.create_with_input(
            MiniAppCreateInput {
                name,
                description,
                icon,
                category,
                tags,
                source,
                permissions,
                ai_context,
                chrome: None,
            },
            workspace_root,
        )
        .await
    }

    pub async fn create_with_input(
        &self,
        input: MiniAppCreateInput,
        workspace_root: Option<&Path>,
    ) -> OpenBitFunResult<MiniApp> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().timestamp_millis();
        let compiled_html = self.compile_source(
            &id,
            &input.source,
            &input.permissions,
            "dark",
            workspace_root,
        )?;
        self.runtime_facade()
            .create_app(id, input, compiled_html, now)
            .await
            .map_err(map_miniapp_port_error)
    }

    /// Update existing MiniApp (increment version, recompile, save).
    #[allow(clippy::too_many_arguments)]
    pub async fn update(
        &self,
        app_id: &str,
        name: Option<String>,
        description: Option<String>,
        icon: Option<String>,
        category: Option<String>,
        tags: Option<Vec<String>>,
        source: Option<MiniAppSource>,
        permissions: Option<MiniAppPermissions>,
        ai_context: Option<MiniAppAiContext>,
        workspace_root: Option<&Path>,
    ) -> OpenBitFunResult<MiniApp> {
        self.update_with_patch(
            app_id,
            MiniAppUpdatePatch {
                name,
                description,
                icon,
                category,
                tags,
                source,
                permissions,
                ai_context,
                chrome: None,
            },
            workspace_root,
        )
        .await
    }

    pub async fn update_with_patch(
        &self,
        app_id: &str,
        patch: MiniAppUpdatePatch,
        workspace_root: Option<&Path>,
    ) -> OpenBitFunResult<MiniApp> {
        let previous_app = self.storage.load(app_id).await?;
        let now = Utc::now().timestamp_millis();
        let compiled_html = if self.uses_market_strict_runtime(app_id).await {
            self.compile_market_source(
                app_id,
                patch.source_for_compile(&previous_app),
                patch.permissions_for_compile(&previous_app),
                "dark",
                workspace_root,
            )?
        } else {
            self.compile_source(
                app_id,
                patch.source_for_compile(&previous_app),
                patch.permissions_for_compile(&previous_app),
                "dark",
                workspace_root,
            )?
        };
        self.runtime_facade()
            .persist_update_result_for_app(
                app_id.to_string(),
                previous_app,
                patch,
                compiled_html,
                now,
            )
            .await
            .map_err(map_miniapp_port_error)
    }

    /// Delete MiniApp and its directory.
    pub async fn delete(&self, app_id: &str) -> OpenBitFunResult<()> {
        self.granted_paths.write().await.remove(app_id);
        self.storage.delete(app_id).await
    }

    /// Get the path manager (for external callers that need paths like miniapp_dir).
    pub fn path_manager(&self) -> &Arc<crate::infrastructure::PathManager> {
        &self.path_manager
    }

    /// Resolve permission policy for the given app (for JS Worker startup).
    pub async fn resolve_policy_for_app(
        &self,
        app_id: &str,
        permissions: &MiniAppPermissions,
        workspace_root: Option<&Path>,
    ) -> serde_json::Value {
        let app_data_dir = self.path_manager.miniapp_dir(app_id);
        let gp = self.granted_paths.read().await;
        let granted = gp.get(app_id).map(Vec::as_slice).unwrap_or(&[]);
        let request = MiniAppPermissionPolicyRequest::from_paths(
            app_id,
            &app_data_dir,
            workspace_root,
            granted,
        );
        resolve_policy_with_request(permissions, &request)
    }

    pub async fn resolve_policy_for_draft(
        &self,
        app_id: &str,
        draft_id: &str,
        permissions: &MiniAppPermissions,
        workspace_root: Option<&Path>,
    ) -> serde_json::Value {
        let app_data_dir = self.storage.draft_dir(app_id, draft_id);
        let gp = self.granted_paths.read().await;
        let granted = gp.get(app_id).map(Vec::as_slice).unwrap_or(&[]);
        let request = MiniAppPermissionPolicyRequest::from_paths(
            app_id,
            &app_data_dir,
            workspace_root,
            granted,
        );
        resolve_policy_with_request(permissions, &request)
    }

    /// Snapshot of user-granted extra paths for an app (used by the host-side dispatch
    /// to mirror what `resolve_policy_for_app` would inject into the worker policy).
    pub async fn granted_paths_for_app(&self, app_id: &str) -> Vec<PathBuf> {
        let gp = self.granted_paths.read().await;
        gp.get(app_id).cloned().unwrap_or_default()
    }

    /// Grant workspace access for an app (no-op; workspace context is supplied by caller).
    pub async fn grant_workspace(&self, _app_id: &str) {}

    /// Grant path (user-selected) for an app.
    pub async fn grant_path(&self, app_id: &str, path: PathBuf) {
        let mut guard = self.granted_paths.write().await;
        let list = guard.entry(app_id.to_string()).or_default();
        if !list.contains(&path) {
            list.push(path);
        }
    }

    /// Get app storage (KV) value.
    pub async fn get_storage(
        &self,
        app_id: &str,
        key: &str,
    ) -> OpenBitFunResult<serde_json::Value> {
        let storage = self.storage.load_app_storage(app_id).await?;
        Ok(storage.get(key).cloned().unwrap_or(serde_json::Value::Null))
    }

    /// Set app storage (KV) value.
    pub async fn set_storage(
        &self,
        app_id: &str,
        key: &str,
        value: serde_json::Value,
    ) -> OpenBitFunResult<()> {
        self.storage.save_app_storage(app_id, key, value).await
    }

    pub async fn get_draft_storage(
        &self,
        app_id: &str,
        draft_id: &str,
        key: &str,
    ) -> OpenBitFunResult<serde_json::Value> {
        let storage = self.storage.load_draft_storage(app_id, draft_id).await?;
        Ok(storage.get(key).cloned().unwrap_or(serde_json::Value::Null))
    }

    pub async fn set_draft_storage(
        &self,
        app_id: &str,
        draft_id: &str,
        key: &str,
        value: serde_json::Value,
    ) -> OpenBitFunResult<()> {
        self.storage
            .save_draft_storage(app_id, draft_id, key, value)
            .await
    }

    pub async fn create_draft(
        &self,
        app_id: &str,
        appearance_mode: &str,
        workspace_root: Option<&Path>,
    ) -> OpenBitFunResult<MiniAppDraft> {
        let app = self.get(app_id).await?;
        let now = Utc::now().timestamp_millis();
        let draft_id = Uuid::new_v4().to_string();
        let compiled_html = self.compile_source_with_app_data_dir(
            app_id,
            &self.storage.draft_dir(app_id, &draft_id),
            &app.source,
            &app.permissions,
            appearance_mode,
            workspace_root,
        )?;
        let draft_root = self
            .storage
            .draft_dir(app_id, &draft_id)
            .to_string_lossy()
            .to_string();
        self.runtime_facade()
            .persist_draft_for_app(
                app_id.to_string(),
                draft_id,
                draft_root,
                app,
                compiled_html,
                now,
            )
            .await
            .map_err(map_miniapp_port_error)
    }

    pub async fn get_draft(&self, app_id: &str, draft_id: &str) -> OpenBitFunResult<MiniAppDraft> {
        self.runtime_facade()
            .get_draft(
                app_id.to_string(),
                draft_id.to_string(),
                self.draft_root_string(app_id, draft_id),
            )
            .await
            .map_err(map_miniapp_port_error)
    }

    pub async fn sync_draft_from_fs(
        &self,
        app_id: &str,
        draft_id: &str,
        appearance_mode: &str,
        workspace_root: Option<&Path>,
    ) -> OpenBitFunResult<MiniAppDraft> {
        let draft = self.get_draft(app_id, draft_id).await?;
        let now = Utc::now().timestamp_millis();
        let compiled_html = self.compile_source_with_app_data_dir(
            app_id,
            &self.storage.draft_dir(app_id, draft_id),
            &draft.app.source,
            &draft.app.permissions,
            appearance_mode,
            workspace_root,
        )?;
        self.runtime_facade()
            .persist_draft_source_sync_result(draft, compiled_html, now)
            .await
            .map_err(map_miniapp_port_error)
    }

    pub async fn set_draft_permissions(
        &self,
        app_id: &str,
        draft_id: &str,
        permissions: MiniAppPermissions,
        appearance_mode: &str,
        workspace_root: Option<&Path>,
    ) -> OpenBitFunResult<MiniAppDraft> {
        let draft = self.get_draft(app_id, draft_id).await?;
        let now = Utc::now().timestamp_millis();
        let compiled_html = self.compile_source_with_app_data_dir(
            app_id,
            &self.storage.draft_dir(app_id, draft_id),
            &draft.app.source,
            &permissions,
            appearance_mode,
            workspace_root,
        )?;
        self.runtime_facade()
            .persist_draft_permission_update_result(draft, permissions, compiled_html, now)
            .await
            .map_err(map_miniapp_port_error)
    }

    pub async fn permission_diff_for_draft(
        &self,
        app_id: &str,
        draft_id: &str,
    ) -> OpenBitFunResult<MiniAppPermissionDiff> {
        self.runtime_facade()
            .permission_diff_for_draft(app_id.to_string(), draft_id.to_string())
            .await
            .map_err(map_miniapp_port_error)
    }

    pub async fn apply_draft(
        &self,
        app_id: &str,
        draft_id: &str,
        appearance_mode: &str,
        workspace_root: Option<&Path>,
    ) -> OpenBitFunResult<MiniApp> {
        let current = self.get(app_id).await?;
        let draft_app = self.storage.load_draft_app(app_id, draft_id).await?;
        let now = Utc::now().timestamp_millis();
        let compiled_html = self.compile_source(
            app_id,
            &draft_app.source,
            &draft_app.permissions,
            appearance_mode,
            workspace_root,
        )?;
        self.runtime_facade()
            .apply_draft_app(
                current,
                draft_id.to_string(),
                draft_app,
                compiled_html,
                self.customization_baseline(app_id),
                now,
            )
            .await
            .map_err(map_miniapp_port_error)
    }

    pub async fn discard_draft(&self, app_id: &str, draft_id: &str) -> OpenBitFunResult<()> {
        self.runtime_facade()
            .discard_draft(app_id.to_string(), draft_id.to_string())
            .await
            .map_err(map_miniapp_port_error)
    }

    pub async fn mark_stale_drafts_for_cleanup(&self) -> OpenBitFunResult<Vec<PathBuf>> {
        self.storage.mark_stale_drafts_for_cleanup().await
    }

    pub async fn cleanup_marked_drafts(&self, targets: Vec<PathBuf>) -> OpenBitFunResult<()> {
        self.storage.cleanup_marked_drafts(targets).await
    }

    pub async fn load_customization_metadata(
        &self,
        app_id: &str,
    ) -> OpenBitFunResult<Option<MiniAppCustomizationMetadata>> {
        self.storage.load_customization_metadata(app_id).await
    }

    pub async fn save_customization_metadata(
        &self,
        app_id: &str,
        metadata: &MiniAppCustomizationMetadata,
    ) -> OpenBitFunResult<()> {
        self.storage
            .save_customization_metadata(app_id, metadata)
            .await
    }

    pub fn draft_dir(&self, app_id: &str, draft_id: &str) -> PathBuf {
        self.storage.draft_dir(app_id, draft_id)
    }

    fn draft_root_string(&self, app_id: &str, draft_id: &str) -> String {
        self.storage
            .draft_dir(app_id, draft_id)
            .to_string_lossy()
            .to_string()
    }

    fn customization_baseline(&self, app_id: &str) -> MiniAppCustomizationBaseline {
        if let Some(builtin) = crate::miniapp::BUILTIN_APPS
            .iter()
            .find(|builtin| builtin.id == app_id)
        {
            MiniAppCustomizationBaseline::Builtin {
                builtin_id: builtin.id.to_string(),
                builtin_version: builtin.version,
            }
        } else {
            MiniAppCustomizationBaseline::UserCreated
        }
    }

    pub async fn mark_builtin_update_available(
        &self,
        app_id: &str,
        builtin_version: u32,
        source_hash: &str,
        detected_at: i64,
    ) -> OpenBitFunResult<bool> {
        self.runtime_facade()
            .mark_builtin_update_available(
                app_id.to_string(),
                builtin_version,
                source_hash.to_string(),
                detected_at,
            )
            .await
            .map_err(map_miniapp_port_error)
    }

    pub async fn decline_builtin_update(
        &self,
        app_id: &str,
        builtin_version: u32,
        source_hash: &str,
        declined_at: i64,
    ) -> OpenBitFunResult<Option<MiniAppCustomizationMetadata>> {
        self.runtime_facade()
            .decline_builtin_update(
                app_id.to_string(),
                builtin_version,
                source_hash.to_string(),
                declined_at,
            )
            .await
            .map_err(map_miniapp_port_error)
    }

    pub async fn mark_deps_installed(&self, app_id: &str) -> OpenBitFunResult<MiniApp> {
        self.runtime_facade()
            .mark_deps_installed(app_id.to_string())
            .await
            .map_err(map_miniapp_port_error)
    }

    pub async fn clear_worker_restart_required(&self, app_id: &str) -> OpenBitFunResult<MiniApp> {
        self.runtime_facade()
            .clear_worker_restart_required(app_id.to_string())
            .await
            .map_err(map_miniapp_port_error)
    }

    /// List version numbers for an app.
    pub async fn list_versions(&self, app_id: &str) -> OpenBitFunResult<Vec<u32>> {
        self.storage.list_versions(app_id).await
    }

    /// Rollback app to a previous version (loads version snapshot, saves as current).
    pub async fn rollback(&self, app_id: &str, version: u32) -> OpenBitFunResult<MiniApp> {
        let now = Utc::now().timestamp_millis();
        self.runtime_facade()
            .rollback(app_id.to_string(), version, now)
            .await
            .map_err(map_miniapp_port_error)
    }

    /// Recompile app after workspace or appearance changes. Updates compiled_html and saves.
    pub async fn recompile(
        &self,
        app_id: &str,
        appearance_mode: &str,
        workspace_root: Option<&Path>,
    ) -> OpenBitFunResult<MiniApp> {
        let app = self.storage.load(app_id).await?;
        let compiled_html = self.compile_source(
            app_id,
            &app.source,
            &app.permissions,
            appearance_mode,
            workspace_root,
        )?;
        self.runtime_facade()
            .persist_recompile_result_for_app(app, compiled_html, Utc::now().timestamp_millis())
            .await
            .map_err(map_miniapp_port_error)
    }

    pub async fn sync_from_fs(
        &self,
        app_id: &str,
        appearance_mode: &str,
        workspace_root: Option<&Path>,
    ) -> OpenBitFunResult<MiniApp> {
        let previous_app = self.storage.load(app_id).await?;
        let source = self.storage.load_source_only(app_id).await?;
        let compiled_html = self.compile_source(
            app_id,
            &source,
            &previous_app.permissions,
            appearance_mode,
            workspace_root,
        )?;
        self.runtime_facade()
            .persist_sync_from_fs_result_for_app(
                app_id.to_string(),
                previous_app,
                source,
                compiled_html,
                Utc::now().timestamp_millis(),
            )
            .await
            .map_err(map_miniapp_port_error)
    }

    /// Import a MiniApp from a directory (e.g. miniapps/git-graph). Copies meta, source, package.json, storage into a new app id and recompiles.
    pub async fn import_from_path(
        &self,
        source_path: PathBuf,
        workspace_root: Option<&Path>,
    ) -> OpenBitFunResult<MiniApp> {
        let id = Uuid::new_v4().to_string();
        let imported_at = Utc::now().timestamp_millis();
        self.runtime_facade()
            .import_from_path(
                &self.storage,
                self,
                MiniAppImportFromPathRequest {
                    source_path,
                    app_id: id,
                    appearance_mode: "dark".to_string(),
                    workspace_root: workspace_root.map(Path::to_path_buf),
                    imported_at,
                    recompiled_at: Utc::now().timestamp_millis(),
                },
            )
            .await
            .map_err(map_miniapp_port_error)
    }

    /// Commit a locally revalidated marketplace package under a new local UUID.
    /// The marketplace release number is stored in origin metadata and remains
    /// independent from the local MiniApp version counter.
    pub async fn install_market_package(
        &self,
        package_meta: MarketPackageMeta,
        source: MiniAppSource,
        origin: InstalledMarketOrigin,
    ) -> OpenBitFunResult<MiniApp> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().timestamp_millis();
        let compiled_html =
            self.compile_market_source(&id, &source, &package_meta.permissions, "dark", None)?;
        self.runtime_facade()
            .install_market_app(id, package_meta, source, origin, compiled_html, now)
            .await
            .map_err(map_miniapp_port_error)
    }

    /// Import a self-contained `.bfminiapp` file without a server-attested
    /// listing origin. It still receives the strict runtime profile, but is
    /// labeled as an ordinary import because a downloaded file carries no
    /// authenticated listing/release envelope.
    pub async fn install_strict_package_import(
        &self,
        package_meta: MarketPackageMeta,
        source: MiniAppSource,
    ) -> OpenBitFunResult<MiniApp> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().timestamp_millis();
        let compiled_html =
            self.compile_market_source(&id, &source, &package_meta.permissions, "dark", None)?;
        self.runtime_facade()
            .import_strict_package(id, package_meta, source, compiled_html, now)
            .await
            .map_err(map_miniapp_port_error)
    }

    /// Replace an installed marketplace app after a manual update decision.
    /// Storage is preserved and the old local version is snapshotted before an
    /// atomic directory swap.
    pub async fn update_market_package(
        &self,
        app_id: &str,
        package_meta: MarketPackageMeta,
        source: MiniAppSource,
        origin: InstalledMarketOrigin,
    ) -> OpenBitFunResult<MiniApp> {
        let previous = self.storage.load(app_id).await?;
        let now = Utc::now().timestamp_millis();
        let compiled_html =
            self.compile_market_source(app_id, &source, &package_meta.permissions, "dark", None)?;
        self.runtime_facade()
            .update_market_app(previous, package_meta, source, origin, compiled_html, now)
            .await
            .map_err(map_miniapp_port_error)
    }
}

impl MiniAppCompilePort for MiniAppManager {
    fn compile_app(
        &self,
        app_id: String,
        source: MiniAppSource,
        permissions: MiniAppPermissions,
        appearance_mode: String,
        workspace_root: Option<PathBuf>,
    ) -> MiniAppPortFuture<'_, String> {
        Box::pin(async move {
            self.compile_source(
                &app_id,
                &source,
                &permissions,
                &appearance_mode,
                workspace_root.as_deref(),
            )
            .map_err(map_openbitfun_error_to_miniapp_port_error)
        })
    }
}

fn map_openbitfun_error_to_miniapp_port_error(error: OpenBitFunError) -> MiniAppPortError {
    let kind = match &error {
        OpenBitFunError::NotFound(_) => MiniAppPortErrorKind::NotFound,
        OpenBitFunError::Validation(_) => MiniAppPortErrorKind::InvalidInput,
        OpenBitFunError::Deserialization(_) | OpenBitFunError::Serialization(_) => {
            MiniAppPortErrorKind::Deserialization
        }
        OpenBitFunError::Io(io_error)
            if io_error.kind() == std::io::ErrorKind::PermissionDenied =>
        {
            MiniAppPortErrorKind::PermissionDenied
        }
        OpenBitFunError::Io(_) => MiniAppPortErrorKind::Io,
        OpenBitFunError::ProcessError(_) => MiniAppPortErrorKind::RuntimeUnavailable,
        _ => MiniAppPortErrorKind::Backend,
    };
    MiniAppPortError::new(kind, error.to_string())
}

fn map_miniapp_port_error(error: MiniAppPortError) -> OpenBitFunError {
    let message = strip_openbitfun_error_prefix(error.message);
    match error.kind {
        MiniAppPortErrorKind::NotFound => OpenBitFunError::NotFound(message),
        MiniAppPortErrorKind::InvalidInput => OpenBitFunError::validation(message),
        MiniAppPortErrorKind::Deserialization => OpenBitFunError::parse(message),
        MiniAppPortErrorKind::PermissionDenied => OpenBitFunError::Io(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            message,
        )),
        MiniAppPortErrorKind::RuntimeUnavailable => OpenBitFunError::ProcessError(message),
        MiniAppPortErrorKind::Io => OpenBitFunError::io(message),
        MiniAppPortErrorKind::Backend => OpenBitFunError::service(message),
    }
}

fn strip_openbitfun_error_prefix(message: String) -> String {
    const PREFIXES: &[&str] = &[
        "Not found: ",
        "Validation error: ",
        "Deserialization error: ",
        "IO error: ",
        "Process error: ",
        "Service error: ",
    ];

    for prefix in PREFIXES {
        if let Some(stripped) = message.strip_prefix(prefix) {
            return stripped.to_string();
        }
    }
    message
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::miniapp::types::{
        FsPermissions, MiniAppMeta, MiniAppPermissions, MiniAppSource, NpmDep,
    };
    use openbitfun_product_domains::miniapp::storage::{
        COMPILED_HTML, DRAFT_JSON, ESM_DEPS_JSON, INDEX_HTML, META_JSON, PACKAGE_JSON, SOURCE_DIR,
        STORAGE_JSON, STYLE_CSS, UI_JS, WORKER_JS,
    };

    struct TestMiniAppManager {
        manager: MiniAppManager,
        root: std::path::PathBuf,
    }

    impl std::ops::Deref for TestMiniAppManager {
        type Target = MiniAppManager;

        fn deref(&self) -> &Self::Target {
            &self.manager
        }
    }

    impl Drop for TestMiniAppManager {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn test_manager() -> TestMiniAppManager {
        let root = std::env::temp_dir().join(format!(
            "openbitfun-miniapp-manager-draft-{}",
            uuid::Uuid::new_v4()
        ));
        let path_manager =
            Arc::new(crate::infrastructure::PathManager::with_user_root_for_tests(root.clone()));
        TestMiniAppManager {
            manager: MiniAppManager::new(path_manager),
            root,
        }
    }

    fn sample_source(css: &str) -> MiniAppSource {
        MiniAppSource {
            html: "<!DOCTYPE html><html><head></head><body><div id=\"app\"></div></body></html>"
                .to_string(),
            css: css.to_string(),
            ui_js: "document.getElementById('app').textContent = 'demo';".to_string(),
            esm_dependencies: Vec::new(),
            worker_js: String::new(),
            npm_dependencies: Vec::new(),
        }
    }

    async fn create_sample_app(manager: &MiniAppManager) -> MiniApp {
        manager
            .create(
                "Demo".to_string(),
                "Demo app".to_string(),
                "box".to_string(),
                "utility".to_string(),
                vec!["demo".to_string()],
                sample_source("body { color: black; }"),
                MiniAppPermissions::default(),
                None,
                None,
            )
            .await
            .unwrap()
    }

    #[test]
    fn miniapp_port_error_mapping_preserves_manager_error_shape() {
        let not_found = map_miniapp_port_error(MiniAppPortError::new(
            MiniAppPortErrorKind::NotFound,
            "Not found: MiniApp not found: missing",
        ));
        assert_eq!(
            not_found.to_string(),
            "Not found: MiniApp not found: missing"
        );

        let deserialization = map_miniapp_port_error(MiniAppPortError::new(
            MiniAppPortErrorKind::Deserialization,
            "Deserialization error: Invalid draft manifest",
        ));
        assert_eq!(
            deserialization.to_string(),
            "Deserialization error: Invalid draft manifest"
        );

        let permission_denied = map_miniapp_port_error(MiniAppPortError::new(
            MiniAppPortErrorKind::PermissionDenied,
            "IO error: access denied",
        ));
        match permission_denied {
            OpenBitFunError::Io(error) => {
                assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
                assert_eq!(error.to_string(), "access denied");
            }
            other => panic!("expected permission denied IO error, got {other:?}"),
        }
    }

    async fn write_import_source(root: &std::path::Path) {
        let source_dir = root.join(SOURCE_DIR);
        tokio::fs::create_dir_all(&source_dir).await.unwrap();
        let meta = MiniAppMeta {
            chrome: None,
            id: "template-id".to_string(),
            name: "Imported".to_string(),
            description: "Imported app".to_string(),
            icon: "box".to_string(),
            category: "utility".to_string(),
            tags: vec!["imported".to_string()],
            version: 7,
            created_at: 11,
            updated_at: 12,
            permissions: MiniAppPermissions::default(),
            ai_context: None,
            runtime: Default::default(),
            runtime_profile: Default::default(),
            i18n: None,
        };
        tokio::fs::write(
            root.join(META_JSON),
            serde_json::to_string_pretty(&meta).unwrap(),
        )
        .await
        .unwrap();
        tokio::fs::write(
            source_dir.join(INDEX_HTML),
            "<!DOCTYPE html><html><head></head><body><div id=\"app\"></div></body></html>",
        )
        .await
        .unwrap();
        tokio::fs::write(source_dir.join(STYLE_CSS), "body { color: blue; }")
            .await
            .unwrap();
        tokio::fs::write(
            source_dir.join(UI_JS),
            "document.getElementById('app').textContent = 'imported';",
        )
        .await
        .unwrap();
        tokio::fs::write(source_dir.join(WORKER_JS), "")
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn runtime_preflight_preserves_recompile_sync_rollback_and_deps_state() {
        let manager = test_manager();
        let mut app = create_sample_app(&manager).await;
        app.source.npm_dependencies = vec![NpmDep {
            name: "lodash".to_string(),
            version: "^4.17.21".to_string(),
        }];
        manager.storage.save(&app).await.unwrap();

        let installed = manager.mark_deps_installed(&app.id).await.unwrap();
        assert!(!installed.runtime.deps_dirty);
        assert!(installed.runtime.worker_restart_required);
        let cleared = manager
            .clear_worker_restart_required(&app.id)
            .await
            .unwrap();
        assert!(!cleared.runtime.worker_restart_required);

        let style_path = manager
            .path_manager()
            .miniapp_dir(&app.id)
            .join(SOURCE_DIR)
            .join(STYLE_CSS);
        tokio::fs::write(&style_path, "body { color: red; }")
            .await
            .unwrap();
        let synced = manager.sync_from_fs(&app.id, "dark", None).await.unwrap();
        assert_eq!(synced.version, app.version + 1);
        assert_eq!(synced.source.css, "body { color: red; }");
        assert!(synced.runtime.deps_dirty);
        assert!(synced.runtime.worker_restart_required);
        assert_eq!(manager.list_versions(&app.id).await.unwrap(), vec![1]);

        let recompiled = manager.recompile(&app.id, "dark", None).await.unwrap();
        assert_eq!(recompiled.version, synced.version);
        assert_eq!(recompiled.source.css, synced.source.css);
        assert!(recompiled.compiled_html.contains("body { color: red; }"));
        assert!(!recompiled.runtime.ui_recompile_required);

        let rolled_back = manager.rollback(&app.id, app.version).await.unwrap();
        assert_eq!(rolled_back.version, recompiled.version + 1);
        // sync_from_fs snapshots the source already loaded from disk; keep this
        // boundary explicit before moving manager/runtime ownership.
        assert_eq!(rolled_back.source.css, "body { color: red; }");
        assert!(rolled_back.runtime.deps_dirty);
        assert!(rolled_back.runtime.worker_restart_required);
        assert_eq!(manager.list_versions(&app.id).await.unwrap(), vec![1, 2]);
    }

    #[tokio::test]
    async fn sync_from_fs_recompiles_without_versioning_unchanged_content() {
        let manager = test_manager();
        let app = create_sample_app(&manager).await;

        let synced = manager.sync_from_fs(&app.id, "dark", None).await.unwrap();

        assert_eq!(synced.version, app.version);
        assert_eq!(synced.updated_at, app.updated_at);
        assert_eq!(synced.runtime.source_revision, app.runtime.source_revision);
        assert_eq!(synced.runtime.content_hash, app.runtime.content_hash);
        assert!(!synced.compiled_html.is_empty());
        assert!(manager.list_versions(&app.id).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn import_from_path_preserves_fallback_files_recompile_and_runtime_state() {
        let manager = test_manager();
        let import_root = std::env::temp_dir().join(format!(
            "openbitfun-miniapp-import-source-{}",
            uuid::Uuid::new_v4()
        ));
        write_import_source(&import_root).await;

        let imported = manager
            .import_from_path(import_root.clone(), None)
            .await
            .unwrap();
        let app_dir = manager.path_manager().miniapp_dir(&imported.id);
        let source_dir = app_dir.join(SOURCE_DIR);

        assert_ne!(imported.id, "template-id");
        assert_eq!(imported.name, "Imported");
        assert_eq!(imported.version, 7);
        assert_eq!(imported.source.css, "body { color: blue; }");
        assert!(imported.compiled_html.contains("textContent = 'imported'"));
        assert!(!imported.runtime.deps_dirty);
        assert!(imported.runtime.worker_restart_required);
        assert!(!imported.runtime.ui_recompile_required);

        assert_eq!(
            tokio::fs::read_to_string(source_dir.join(ESM_DEPS_JSON))
                .await
                .unwrap(),
            "[]"
        );
        assert_eq!(
            tokio::fs::read_to_string(app_dir.join(STORAGE_JSON))
                .await
                .unwrap(),
            "{}"
        );
        let package_json: serde_json::Value = serde_json::from_str(
            &tokio::fs::read_to_string(app_dir.join(PACKAGE_JSON))
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(package_json["name"], format!("miniapp-{}", imported.id));
        assert_eq!(package_json["dependencies"], serde_json::json!({}));
        assert!(tokio::fs::read_to_string(app_dir.join(COMPILED_HTML))
            .await
            .unwrap()
            .contains("textContent = 'imported'"));

        let _ = tokio::fs::remove_dir_all(import_root).await;
    }

    #[tokio::test]
    async fn import_from_path_preserves_invalid_meta_error_shape() {
        let manager = test_manager();
        let import_root = std::env::temp_dir().join(format!(
            "openbitfun-miniapp-invalid-import-source-{}",
            uuid::Uuid::new_v4()
        ));
        tokio::fs::create_dir_all(&import_root).await.unwrap();
        let source_dir = import_root.join(SOURCE_DIR);
        tokio::fs::create_dir_all(&source_dir).await.unwrap();
        for file_name in [INDEX_HTML, STYLE_CSS, UI_JS, WORKER_JS] {
            tokio::fs::write(source_dir.join(file_name), "")
                .await
                .unwrap();
        }
        tokio::fs::write(import_root.join(META_JSON), "{")
            .await
            .unwrap();

        let error = manager.import_from_path(import_root.clone(), None).await;

        match error {
            Err(OpenBitFunError::Deserialization(message)) => {
                assert!(message.starts_with("Invalid meta.json:"));
            }
            other => panic!("expected invalid meta deserialization error, got {other:?}"),
        }
        let _ = tokio::fs::remove_dir_all(import_root).await;
    }

    #[tokio::test]
    async fn draft_lifecycle_keeps_active_storage_and_source_isolated_until_apply() {
        let manager = test_manager();
        let app = create_sample_app(&manager).await;
        manager
            .set_storage(&app.id, "score", serde_json::json!(3))
            .await
            .unwrap();

        let draft = manager.create_draft(&app.id, "dark", None).await.unwrap();
        assert_eq!(draft.source_version, app.version);
        assert_eq!(draft.app.source.css, "body { color: black; }");

        let draft_css = manager
            .storage
            .draft_dir(&app.id, &draft.draft_id)
            .join("source")
            .join("style.css");
        tokio::fs::write(&draft_css, "body { background: white; }")
            .await
            .unwrap();

        let draft = manager
            .sync_draft_from_fs(&app.id, &draft.draft_id, "dark", None)
            .await
            .unwrap();
        assert_eq!(draft.app.source.css, "body { background: white; }");

        let active_before_apply = manager.get(&app.id).await.unwrap();
        assert_eq!(active_before_apply.source.css, "body { color: black; }");
        assert_eq!(
            manager.get_storage(&app.id, "score").await.unwrap(),
            serde_json::json!(3)
        );

        let applied = manager
            .apply_draft(&app.id, &draft.draft_id, "dark", None)
            .await
            .unwrap();

        assert_eq!(applied.version, app.version + 1);
        assert_eq!(applied.source.css, "body { background: white; }");
        assert_eq!(manager.list_versions(&app.id).await.unwrap(), vec![1]);
        assert_eq!(
            manager.get_storage(&app.id, "score").await.unwrap(),
            serde_json::json!(3)
        );
    }

    #[tokio::test]
    async fn unchanged_draft_apply_does_not_require_manifest_or_create_a_version() {
        let manager = test_manager();
        let app = create_sample_app(&manager).await;
        let draft = manager.create_draft(&app.id, "dark", None).await.unwrap();
        let draft_dir = manager.storage.draft_dir(&app.id, &draft.draft_id);
        tokio::fs::remove_file(draft_dir.join(DRAFT_JSON))
            .await
            .unwrap();

        let applied = manager
            .apply_draft(&app.id, &draft.draft_id, "dark", None)
            .await
            .unwrap();

        assert_eq!(applied.version, app.version);
        assert_eq!(applied.source.css, app.source.css);
        assert!(manager.list_versions(&app.id).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn draft_permission_diff_flags_high_risk_changes_before_apply() {
        let manager = test_manager();
        let app = create_sample_app(&manager).await;
        let draft = manager.create_draft(&app.id, "dark", None).await.unwrap();

        let draft_permissions = MiniAppPermissions {
            fs: Some(FsPermissions {
                read: None,
                write: Some(vec!["{workspace}".to_string()]),
            }),
            ..Default::default()
        };
        manager
            .set_draft_permissions(&app.id, &draft.draft_id, draft_permissions, "dark", None)
            .await
            .unwrap();

        let diff = manager
            .permission_diff_for_draft(&app.id, &draft.draft_id)
            .await
            .unwrap();

        assert!(diff.high_risk);
        assert_eq!(diff.added, vec!["fs.write:{workspace}".to_string()]);
        assert!(manager.get(&app.id).await.unwrap().permissions.fs.is_none());
    }
}
