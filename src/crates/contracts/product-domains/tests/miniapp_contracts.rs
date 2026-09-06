#![cfg(feature = "miniapp")]

use openbitfun_product_domains::miniapp::bridge_builder::{build_bridge_script, build_csp_content};
use openbitfun_product_domains::miniapp::builtin::{
    build_builtin_install_marker, build_builtin_package_json, build_builtin_seed_meta,
    builtin_content_hash, builtin_source_files, parse_builtin_install_marker,
    preserved_builtin_created_at, resolve_builtin_seed_action, resolve_builtin_seed_check,
    serialize_builtin_install_marker, should_seed_builtin_app, BuiltinInstallMarker,
    BuiltinMiniAppBundle, BuiltinSeedAction, BuiltinSeedCheck, BUILTIN_INSTALL_MARKER,
    BUILTIN_PLACEHOLDER_COMPILED_HTML,
};
use openbitfun_product_domains::miniapp::compiler::compile;
use openbitfun_product_domains::miniapp::customization::{
    apply_draft_customization_metadata, decline_builtin_update_metadata,
    declined_builtin_update_needs_local_snapshot, is_current_declined_builtin_update,
    mark_builtin_update_available_metadata, MiniAppCustomizationBaseline,
    MiniAppCustomizationLocalSnapshot, MiniAppCustomizationMetadata, MiniAppCustomizationOrigin,
    MiniAppCustomizationOriginKind, MAX_DECLINED_BUILTIN_UPDATES,
};
use openbitfun_product_domains::miniapp::draft::{
    build_draft_manifest, build_draft_response, MINIAPP_DRAFT_STATUS_APPLIED,
    MINIAPP_DRAFT_STATUS_DRAFT,
};
use openbitfun_product_domains::miniapp::exporter::{
    build_export_check_result, export_runtime_label, ExportCheckResult, ExportTarget,
    MISSING_JS_RUNTIME_MESSAGE,
};
use openbitfun_product_domains::miniapp::host_routing::{
    command_basename_allowed, command_basename_for_allowlist, fs_method_access_mode,
    fs_policy_scopes, fs_resolved_path_allowed, host_allowed_by_allowlist, is_host_primitive,
    plan_fs_host_call, plan_fs_legacy_path_check, plan_shell_host_call, shell_exec_cwd,
    shell_exec_default_env, shell_exec_first_token, shell_exec_input_is_empty,
    shell_exec_timeout_ms, split_host_method, FsAccessMode, MiniAppFsHostCallPlan,
    MiniAppFsHostPathCheck, MiniAppHostPlanErrorKind, MiniAppShellHostCallPlan,
};
use openbitfun_product_domains::miniapp::lifecycle::{
    apply_draft_permission_update_result, apply_draft_source_sync_result, apply_draft_to_active,
    apply_import_runtime_state, apply_recompile_result, apply_sync_from_fs_result,
    apply_update_patch, build_created_app, build_deps_revision, build_runtime_state,
    build_source_revision, build_worker_revision, clear_worker_restart_required_state,
    ensure_runtime_state, mark_deps_installed_state, miniapp_content_hash, prepare_draft_app,
    prepare_rollback_app, workspace_dir_string, MiniAppCreateInput, MiniAppUpdatePatch,
};
use openbitfun_product_domains::miniapp::permission_policy::resolve_policy;
use openbitfun_product_domains::miniapp::ports::{
    MiniAppCompilePort, MiniAppImportFromPathRequest, MiniAppImportPort, MiniAppInstallDepsRequest,
    MiniAppPortError, MiniAppPortErrorKind, MiniAppPortFuture, MiniAppRuntimeFacade,
    MiniAppRuntimePort, MiniAppStoragePort,
};
use openbitfun_product_domains::miniapp::runtime::{
    candidate_dirs, candidate_executable_path, detect_runtime, runtime_lookup_order,
    version_manager_roots, versioned_executable_candidate, DetectedRuntime, RuntimeKind,
};
use openbitfun_product_domains::miniapp::storage::{
    build_import_bundle_plan, build_import_fallbacks, build_package_json, parse_npm_dependencies,
    MiniAppImportBundlePlanError, MiniAppImportBundleWriteRequest, MiniAppImportLayout,
    MiniAppStorageLayout, COMPILED_HTML, CUSTOMIZATION_JSON, DRAFTS_CLEANUP_MARKER,
    DRAFTS_CLEANUP_PREFIX, DRAFTS_DIR, DRAFT_JSON, EMPTY_ESM_DEPENDENCIES_JSON, EMPTY_STORAGE_JSON,
    ESM_DEPS_JSON, INDEX_HTML, META_JSON, PACKAGE_JSON, PLACEHOLDER_COMPILED_HTML,
    REQUIRED_SOURCE_FILES, SOURCE_DIR, STORAGE_JSON, STYLE_CSS, UI_JS, VERSIONS_DIR, WORKER_JS,
};
use openbitfun_product_domains::miniapp::types::{
    FsPermissions, MiniApp, MiniAppAiContext, MiniAppI18n, MiniAppMeta, MiniAppPermissions,
    MiniAppRuntimeState, MiniAppSource, NetPermissions, NotificationPermissions, NpmDep,
};
use openbitfun_product_domains::miniapp::worker::{
    install_command_for_runtime, plan_install_deps, select_lru_worker, worker_idle_timeout_ms,
    worker_is_idle, worker_pool_at_capacity, InstallDepsPlan, InstallResult,
};
use std::collections::BTreeMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, RawWaker, RawWakerVTable, Waker};

struct RuntimePortStub;

impl MiniAppRuntimePort for RuntimePortStub {
    fn detect_runtime(
        &self,
    ) -> MiniAppPortFuture<'_, Option<openbitfun_product_domains::miniapp::runtime::DetectedRuntime>>
    {
        Box::pin(async { Ok(None) })
    }

    fn install_deps(
        &self,
        _request: MiniAppInstallDepsRequest,
    ) -> MiniAppPortFuture<'_, InstallResult> {
        Box::pin(async {
            Ok(InstallResult {
                success: true,
                stdout: String::new(),
                stderr: String::new(),
            })
        })
    }
}

#[derive(Clone)]
struct ImportPortStub {
    storage: StoragePortStub,
    meta_json: String,
    writes: Arc<Mutex<Vec<MiniAppImportBundleWriteRequest>>>,
}

impl ImportPortStub {
    fn new(storage: StoragePortStub, meta_json: String) -> Self {
        Self {
            storage,
            meta_json,
            writes: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn writes(&self) -> Vec<MiniAppImportBundleWriteRequest> {
        self.writes.lock().unwrap().clone()
    }
}

impl MiniAppImportPort for ImportPortStub {
    fn read_import_meta_json(&self, _source_path: PathBuf) -> MiniAppPortFuture<'_, String> {
        let meta_json = self.meta_json.clone();
        Box::pin(async move { Ok(meta_json) })
    }

    fn write_import_bundle(
        &self,
        request: MiniAppImportBundleWriteRequest,
    ) -> MiniAppPortFuture<'_, ()> {
        let storage = self.storage.clone();
        let writes = self.writes.clone();
        Box::pin(async move {
            let meta: MiniAppMeta = serde_json::from_str(&request.meta_json).map_err(|error| {
                MiniAppPortError::new(
                    MiniAppPortErrorKind::Deserialization,
                    format!("Invalid meta.json: {error}"),
                )
            })?;
            let mut app = sample_miniapp_for_lifecycle(MiniAppSource {
                html: "<html><body>imported</body></html>".to_string(),
                ..MiniAppSource::default()
            });
            app.id = request.app_id.clone();
            app.name = meta.name;
            app.description = meta.description;
            app.icon = meta.icon;
            app.category = meta.category;
            app.tags = meta.tags;
            app.compiled_html = request.compiled_html.clone();
            app.updated_at = meta.updated_at;
            app.created_at = meta.created_at;
            storage.state.lock().unwrap().current = app;
            writes.lock().unwrap().push(request);
            Ok(())
        })
    }
}

struct CompilePortStub {
    calls: Arc<Mutex<Vec<String>>>,
}

impl CompilePortStub {
    fn new() -> Self {
        Self {
            calls: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
}

impl MiniAppCompilePort for CompilePortStub {
    fn compile_app(
        &self,
        app_id: String,
        source: MiniAppSource,
        _permissions: MiniAppPermissions,
        appearance_mode: String,
        workspace_root: Option<PathBuf>,
    ) -> MiniAppPortFuture<'_, String> {
        let calls = self.calls.clone();
        Box::pin(async move {
            calls.lock().unwrap().push(format!(
                "{}|{}|{}|{}",
                app_id,
                source.html,
                appearance_mode,
                workspace_root
                    .as_deref()
                    .map(Path::to_string_lossy)
                    .unwrap_or_else(|| "".into())
            ));
            Ok(format!("<html>{app_id}:{appearance_mode}</html>"))
        })
    }
}

#[derive(Clone)]
struct StoragePortStub {
    state: Arc<Mutex<StoragePortStubState>>,
}

struct StoragePortStubState {
    current: MiniApp,
    versions: BTreeMap<u32, MiniApp>,
    drafts: BTreeMap<(String, String), (MiniApp, serde_json::Value)>,
    customization: BTreeMap<String, MiniAppCustomizationMetadata>,
    save_count: usize,
    saved_version_numbers: Vec<u32>,
    deleted_drafts: Vec<(String, String)>,
}

impl StoragePortStub {
    fn new(current: MiniApp) -> Self {
        Self {
            state: Arc::new(Mutex::new(StoragePortStubState {
                current,
                versions: BTreeMap::new(),
                drafts: BTreeMap::new(),
                customization: BTreeMap::new(),
                save_count: 0,
                saved_version_numbers: Vec::new(),
                deleted_drafts: Vec::new(),
            })),
        }
    }

    fn current(&self) -> MiniApp {
        self.state.lock().unwrap().current.clone()
    }

    fn save_count(&self) -> usize {
        self.state.lock().unwrap().save_count
    }

    fn saved_version_numbers(&self) -> Vec<u32> {
        self.state.lock().unwrap().saved_version_numbers.clone()
    }

    fn customization_metadata(&self, app_id: &str) -> Option<MiniAppCustomizationMetadata> {
        self.state
            .lock()
            .unwrap()
            .customization
            .get(app_id)
            .cloned()
    }

    fn deleted_drafts(&self) -> Vec<(String, String)> {
        self.state.lock().unwrap().deleted_drafts.clone()
    }
}

impl MiniAppStoragePort for StoragePortStub {
    fn list_app_ids(&self) -> MiniAppPortFuture<'_, Vec<String>> {
        let app_id = self.state.lock().unwrap().current.id.clone();
        Box::pin(async move { Ok(vec![app_id]) })
    }

    fn load(&self, app_id: String) -> MiniAppPortFuture<'_, MiniApp> {
        let result = {
            let state = self.state.lock().unwrap();
            if state.current.id == app_id {
                Ok(state.current.clone())
            } else {
                Err(MiniAppPortError::new(
                    MiniAppPortErrorKind::NotFound,
                    format!("App not found: {app_id}"),
                ))
            }
        };
        Box::pin(async move { result })
    }

    fn load_meta(
        &self,
        app_id: String,
    ) -> MiniAppPortFuture<'_, openbitfun_product_domains::miniapp::types::MiniAppMeta> {
        let result = {
            let state = self.state.lock().unwrap();
            if state.current.id == app_id {
                Ok((&state.current).into())
            } else {
                Err(MiniAppPortError::new(
                    MiniAppPortErrorKind::NotFound,
                    format!("App not found: {app_id}"),
                ))
            }
        };
        Box::pin(async move { result })
    }

    fn load_source(&self, app_id: String) -> MiniAppPortFuture<'_, MiniAppSource> {
        let result = {
            let state = self.state.lock().unwrap();
            if state.current.id == app_id {
                Ok(state.current.source.clone())
            } else {
                Err(MiniAppPortError::new(
                    MiniAppPortErrorKind::NotFound,
                    format!("App not found: {app_id}"),
                ))
            }
        };
        Box::pin(async move { result })
    }

    fn save(&self, app: MiniApp) -> MiniAppPortFuture<'_, ()> {
        let state = self.state.clone();
        Box::pin(async move {
            let mut state = state.lock().unwrap();
            state.current = app;
            state.save_count += 1;
            Ok(())
        })
    }

    fn save_version(
        &self,
        _app_id: String,
        version: u32,
        app: MiniApp,
    ) -> MiniAppPortFuture<'_, ()> {
        let state = self.state.clone();
        Box::pin(async move {
            let mut state = state.lock().unwrap();
            state.versions.insert(version, app);
            state.saved_version_numbers.push(version);
            Ok(())
        })
    }

    fn load_app_storage(&self, _app_id: String) -> MiniAppPortFuture<'_, serde_json::Value> {
        Box::pin(async { Ok(serde_json::json!({})) })
    }

    fn save_app_storage(
        &self,
        _app_id: String,
        _key: String,
        _value: serde_json::Value,
    ) -> MiniAppPortFuture<'_, ()> {
        Box::pin(async { Ok(()) })
    }

    fn load_draft_app(&self, app_id: String, draft_id: String) -> MiniAppPortFuture<'_, MiniApp> {
        let result = self
            .state
            .lock()
            .unwrap()
            .drafts
            .get(&(app_id.clone(), draft_id.clone()))
            .map(|(app, _)| app.clone())
            .ok_or_else(|| {
                MiniAppPortError::new(
                    MiniAppPortErrorKind::NotFound,
                    format!("Draft not found: {app_id}/{draft_id}"),
                )
            });
        Box::pin(async move { result })
    }

    fn load_draft_manifest(
        &self,
        app_id: String,
        draft_id: String,
    ) -> MiniAppPortFuture<'_, serde_json::Value> {
        let result = self
            .state
            .lock()
            .unwrap()
            .drafts
            .get(&(app_id.clone(), draft_id.clone()))
            .map(|(_, manifest)| manifest.clone())
            .ok_or_else(|| {
                MiniAppPortError::new(
                    MiniAppPortErrorKind::NotFound,
                    format!("Draft not found: {app_id}/{draft_id}"),
                )
            });
        Box::pin(async move { result })
    }

    fn save_draft(
        &self,
        app_id: String,
        draft_id: String,
        app: MiniApp,
        manifest: serde_json::Value,
    ) -> MiniAppPortFuture<'_, ()> {
        let state = self.state.clone();
        Box::pin(async move {
            state
                .lock()
                .unwrap()
                .drafts
                .insert((app_id, draft_id), (app, manifest));
            Ok(())
        })
    }

    fn delete_draft(&self, app_id: String, draft_id: String) -> MiniAppPortFuture<'_, ()> {
        let state = self.state.clone();
        Box::pin(async move {
            let mut state = state.lock().unwrap();
            state.drafts.remove(&(app_id.clone(), draft_id.clone()));
            state.deleted_drafts.push((app_id, draft_id));
            Ok(())
        })
    }

    fn load_customization_metadata(
        &self,
        app_id: String,
    ) -> MiniAppPortFuture<'_, Option<MiniAppCustomizationMetadata>> {
        let metadata = self
            .state
            .lock()
            .unwrap()
            .customization
            .get(&app_id)
            .cloned();
        Box::pin(async move { Ok(metadata) })
    }

    fn save_customization_metadata(
        &self,
        app_id: String,
        metadata: MiniAppCustomizationMetadata,
    ) -> MiniAppPortFuture<'_, ()> {
        let state = self.state.clone();
        Box::pin(async move {
            state.lock().unwrap().customization.insert(app_id, metadata);
            Ok(())
        })
    }

    fn install_market_atomic(
        &self,
        app: MiniApp,
        metadata: MiniAppCustomizationMetadata,
    ) -> MiniAppPortFuture<'_, ()> {
        let state = self.state.clone();
        Box::pin(async move {
            let app_id = app.id.clone();
            let mut state = state.lock().unwrap();
            state.current = app;
            state.customization.insert(app_id, metadata);
            state.save_count += 1;
            Ok(())
        })
    }

    fn replace_market_atomic(
        &self,
        previous: MiniApp,
        next: MiniApp,
        metadata: MiniAppCustomizationMetadata,
    ) -> MiniAppPortFuture<'_, ()> {
        let state = self.state.clone();
        Box::pin(async move {
            let app_id = next.id.clone();
            let previous_version = previous.version;
            let mut state = state.lock().unwrap();
            state.versions.insert(previous_version, previous);
            state.saved_version_numbers.push(previous_version);
            state.current = next;
            state.customization.insert(app_id, metadata);
            state.save_count += 1;
            Ok(())
        })
    }

    fn delete(&self, _app_id: String) -> MiniAppPortFuture<'_, ()> {
        Box::pin(async { Ok(()) })
    }

    fn list_versions(&self, _app_id: String) -> MiniAppPortFuture<'_, Vec<u32>> {
        let versions = self
            .state
            .lock()
            .unwrap()
            .versions
            .keys()
            .copied()
            .collect();
        Box::pin(async move { Ok(versions) })
    }

    fn load_version(&self, _app_id: String, version: u32) -> MiniAppPortFuture<'_, MiniApp> {
        let result = self
            .state
            .lock()
            .unwrap()
            .versions
            .get(&version)
            .cloned()
            .ok_or_else(|| {
                MiniAppPortError::new(
                    MiniAppPortErrorKind::NotFound,
                    format!("Version v{version} not found"),
                )
            });
        Box::pin(async move { result })
    }
}

fn block_on<F: Future>(future: F) -> F::Output {
    let waker = noop_waker();
    let mut context = Context::from_waker(&waker);
    let mut future = pin!(future);
    loop {
        match Future::poll(future.as_mut(), &mut context) {
            Poll::Ready(value) => return value,
            Poll::Pending => std::thread::yield_now(),
        }
    }
}

fn noop_waker() -> Waker {
    unsafe fn clone(_: *const ()) -> RawWaker {
        RawWaker::new(std::ptr::null(), &VTABLE)
    }
    unsafe fn wake(_: *const ()) {}
    unsafe fn wake_by_ref(_: *const ()) {}
    unsafe fn drop(_: *const ()) {}

    static VTABLE: RawWakerVTable = RawWakerVTable::new(clone, wake, wake_by_ref, drop);
    unsafe { Waker::from_raw(RawWaker::new(std::ptr::null(), &VTABLE)) }
}

#[test]
fn miniapp_csp_content_preserves_net_allow_contract() {
    let permissions = MiniAppPermissions {
        net: Some(NetPermissions {
            allow: Some(vec!["api.example.com".to_string()]),
        }),
        ..MiniAppPermissions::default()
    };

    let csp = build_csp_content(&permissions);

    assert_eq!(
        csp,
        "default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https:; style-src 'self' 'unsafe-inline' https:; connect-src 'self' 'self' https://esm.sh api.example.com; img-src 'self' data: https:; font-src 'self' https:; object-src 'none'; base-uri 'self';"
    );
}

#[test]
fn miniapp_permissions_support_host_notifications_without_domain_specific_fields() {
    let permissions: MiniAppPermissions = serde_json::from_value(serde_json::json!({
        "notifications": { "system": true },
        "net": { "allow": ["*"] }
    }))
    .unwrap();

    assert_eq!(
        permissions.notifications,
        Some(NotificationPermissions { system: true })
    );
    assert_eq!(permissions.net.unwrap().allow.unwrap(), vec!["*"]);
}

#[test]
fn miniapp_bridge_exposes_host_notification_namespace() {
    let bridge = build_bridge_script("app-1", "/tmp/app", "/tmp/workspace", "dark", "win32");

    assert!(bridge.contains("notifications:"));
    assert!(bridge.contains("notifications.system"));
    assert!(bridge.contains("system:"));
    assert!(bridge.contains("system.openExternal"));
}

#[test]
fn miniapp_bridge_exposes_deck_render_page_namespace() {
    let bridge = build_bridge_script("app-1", "/tmp/app", "/tmp/workspace", "dark", "win32");

    assert!(bridge.contains("deck:"));
    assert!(bridge.contains("deck.renderPage"));
}

#[test]
fn miniapp_bridge_exposes_topic_session_lifecycle() {
    let bridge = build_bridge_script("app-1", "/tmp/app", "/tmp/workspace", "dark", "win32");

    assert!(bridge.contains("agent.ensureSession"));
    assert!(bridge.contains("chat.focusSession"));
    assert!(bridge.contains("chat.clearSession"));
    assert!(!bridge.contains("loopx.attach"));
    assert!(bridge.contains("_chatUserMessagePending"));
    assert!(bridge.contains("chat.completeUserMessage"));
}

#[test]
fn miniapp_bridge_injects_loopx_only_for_the_builtin_identity() {
    let ordinary = build_bridge_script("app-1", "/tmp/app", "/tmp/workspace", "dark", "win32");
    let builtin = build_bridge_script(
        "builtin-bitfun-loopx",
        "/tmp/app",
        "/tmp/workspace",
        "dark",
        "win32",
    );

    assert!(!ordinary.contains("loopx.attach"));
    assert!(builtin.contains("loopx.attach"));
    assert!(builtin.contains("Private product extension"));
}

#[test]
fn miniapp_permission_policy_preserves_scope_resolution() {
    let permissions = MiniAppPermissions {
        fs: Some(FsPermissions {
            read: Some(vec!["{appdata}".to_string(), "{workspace}".to_string()]),
            write: Some(vec!["{user-selected}".to_string()]),
        }),
        ..MiniAppPermissions::default()
    };

    let policy = resolve_policy(
        &permissions,
        "app_1",
        Path::new("/tmp/app-data"),
        Some(Path::new("/tmp/workspace")),
        &[PathBuf::from("/tmp/granted")],
    );

    assert_eq!(policy["fs"]["read"][0], "/tmp/app-data");
    assert_eq!(policy["fs"]["read"][1], "/tmp/workspace");
    assert_eq!(policy["fs"]["read"][2], "/tmp/granted");
    assert_eq!(policy["fs"]["write"][0], "/tmp/granted");
}

#[test]
fn miniapp_compiler_preserves_head_injection_contract() {
    let source = MiniAppSource {
        html: r#"<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>x</body></html>"#
            .to_string(),
        ui_js: "console.log('ready')".to_string(),
        ..MiniAppSource::default()
    };

    let out = compile(
        &source,
        &MiniAppPermissions::default(),
        "app-id",
        "/tmp/app",
        "/tmp/workspace",
        "dark",
    )
    .unwrap();

    assert!(out.contains("<meta charset=\"utf-8\">"));
    assert!(out.contains("data-openbitfun-appearance-mode=\"dark\""));
    assert!(out.contains("*::-webkit-scrollbar-track-piece"));
    assert!(out.contains("scrollbar-width: auto !important"));
    assert!(out.contains("scrollbar-color: var(--openbitfun-scrollbar-thumb) transparent"));
    assert!(out.contains("<script type=\"module\">"));
    assert!(out.contains("console.log('ready')"));
}

#[test]
fn miniapp_export_and_runtime_dtos_remain_stable() {
    assert_eq!(RuntimeKind::Node, RuntimeKind::Node);

    let target = serde_json::to_string(&ExportTarget::Tauri).unwrap();
    assert_eq!(target, "\"Tauri\"");

    let check = ExportCheckResult {
        ready: false,
        runtime: None,
        missing: vec!["No JS runtime (install Bun or Node.js)".to_string()],
        warnings: Vec::new(),
    };
    let json = serde_json::to_value(&check).unwrap();
    assert_eq!(json["ready"], false);
    assert_eq!(json["missing"][0], "No JS runtime (install Bun or Node.js)");

    let install = InstallResult {
        success: true,
        stdout: "ok".to_string(),
        stderr: String::new(),
    };
    let json = serde_json::to_value(&install).unwrap();
    assert_eq!(json["success"], true);
    assert_eq!(json["stdout"], "ok");

    assert_eq!(export_runtime_label(&RuntimeKind::Bun), "bun");
    assert_eq!(export_runtime_label(&RuntimeKind::Node), "node");
    assert_eq!(
        MISSING_JS_RUNTIME_MESSAGE,
        "No JS runtime (install Bun or Node.js)"
    );
    let missing_runtime = build_export_check_result(None);
    assert!(!missing_runtime.ready);
    assert_eq!(missing_runtime.runtime, None);
    assert_eq!(missing_runtime.missing, vec![MISSING_JS_RUNTIME_MESSAGE]);
    let detected_runtime = build_export_check_result(Some(&RuntimeKind::Node));
    assert!(detected_runtime.ready);
    assert_eq!(detected_runtime.runtime.as_deref(), Some("node"));
    assert!(detected_runtime.missing.is_empty());
}

#[test]
fn miniapp_storage_layout_preserves_file_shape_contract() {
    let root = PathBuf::from("/openbitfun/miniapps");
    let layout = MiniAppStorageLayout::new(&root, "app-1");

    assert_eq!(META_JSON, "meta.json");
    assert_eq!(SOURCE_DIR, "source");
    assert_eq!(INDEX_HTML, "index.html");
    assert_eq!(STYLE_CSS, "style.css");
    assert_eq!(UI_JS, "ui.js");
    assert_eq!(WORKER_JS, "worker.js");
    assert_eq!(PACKAGE_JSON, "package.json");
    assert_eq!(ESM_DEPS_JSON, "esm_dependencies.json");
    assert_eq!(COMPILED_HTML, "compiled.html");
    assert_eq!(STORAGE_JSON, "storage.json");
    assert_eq!(VERSIONS_DIR, "versions");
    assert_eq!(DRAFTS_DIR, ".drafts");
    assert_eq!(DRAFTS_CLEANUP_PREFIX, ".drafts.cleanup-");
    assert_eq!(DRAFTS_CLEANUP_MARKER, ".cleanup-pending");
    assert_eq!(DRAFT_JSON, "draft.json");
    assert_eq!(CUSTOMIZATION_JSON, ".customization.json");

    assert_eq!(layout.app_dir(), root.join("app-1"));
    assert_eq!(layout.meta_path(), root.join("app-1").join(META_JSON));
    assert_eq!(
        layout.source_file_path(INDEX_HTML),
        root.join("app-1").join(SOURCE_DIR).join(INDEX_HTML)
    );
    assert_eq!(
        layout.version_path(3),
        root.join("app-1").join(VERSIONS_DIR).join("v3.json")
    );
    assert_eq!(layout.versions_dir(), root.join("app-1").join(VERSIONS_DIR));
    assert_eq!(
        layout.customization_path(),
        root.join("app-1").join(CUSTOMIZATION_JSON)
    );
    assert_eq!(
        MiniAppStorageLayout::drafts_root(&root),
        root.join(DRAFTS_DIR)
    );
    assert_eq!(
        MiniAppStorageLayout::draft_dir(&root, "app-1", "draft-1"),
        root.join(DRAFTS_DIR).join("app-1").join("draft-1")
    );
    assert_eq!(
        MiniAppStorageLayout::draft_source_dir(&root, "app-1", "draft-1"),
        root.join(DRAFTS_DIR)
            .join("app-1")
            .join("draft-1")
            .join(SOURCE_DIR)
    );
    assert_eq!(
        MiniAppStorageLayout::draft_manifest_path(&root, "app-1", "draft-1"),
        root.join(DRAFTS_DIR)
            .join("app-1")
            .join("draft-1")
            .join(DRAFT_JSON)
    );
    assert_eq!(
        MiniAppStorageLayout::cleanup_drafts_root(&root, "cleanup-id"),
        root.join(".drafts.cleanup-cleanup-id")
    );
}

#[test]
fn miniapp_runtime_search_plan_preserves_common_install_locations() {
    let home = PathBuf::from("/home/openbitfun");
    let candidates = candidate_dirs(Some(&home));

    assert_eq!(candidates[0], PathBuf::from("/opt/homebrew/bin"));
    assert!(candidates.contains(&home.join(".bun").join("bin")));
    assert!(candidates.contains(&home.join(".asdf").join("shims")));

    let roots = version_manager_roots(Some(&home));
    assert_eq!(roots[0], home.join(".nvm").join("versions").join("node"));
    assert!(roots.contains(&home.join(".fnm").join("node-versions")));

    assert_eq!(runtime_lookup_order(), &["bun", "node"]);
    let _detect_runtime: fn() -> Option<DetectedRuntime> = detect_runtime;
    assert_eq!(
        candidate_executable_path(Path::new("/usr/local/bin"), "node"),
        PathBuf::from("/usr/local/bin").join("node")
    );
    assert_eq!(
        versioned_executable_candidate(
            Path::new("/home/openbitfun/.nvm/versions/node/v20"),
            "node"
        ),
        PathBuf::from("/home/openbitfun/.nvm/versions/node/v20")
            .join("bin")
            .join("node")
    );
}

#[test]
fn miniapp_worker_install_command_preserves_runtime_choice() {
    let bun = install_command_for_runtime(&RuntimeKind::Bun, true);
    assert_eq!(bun.program, "bun");
    assert_eq!(bun.args, &["install", "--production"]);

    let node_with_pnpm = install_command_for_runtime(&RuntimeKind::Node, true);
    assert_eq!(node_with_pnpm.program, "pnpm");
    assert_eq!(node_with_pnpm.args, &["install", "--prod"]);

    let node_without_pnpm = install_command_for_runtime(&RuntimeKind::Node, false);
    assert_eq!(node_without_pnpm.program, "npm");
    assert_eq!(node_without_pnpm.args, &["install", "--production"]);

    assert_eq!(
        plan_install_deps(false, &RuntimeKind::Node, true),
        InstallDepsPlan::SkipMissingPackageJson
    );
    assert!(matches!(
        plan_install_deps(true, &RuntimeKind::Node, true),
        InstallDepsPlan::Run(command) if command.program == "pnpm"
    ));
    assert!(!worker_pool_at_capacity(4));
    assert!(worker_pool_at_capacity(5));
    assert!(worker_is_idle(
        10_000,
        10_000 - worker_idle_timeout_ms() - 1
    ));
    assert_eq!(
        select_lru_worker([("newer", 20), ("older", 10)]),
        Some("older".to_string())
    );
}

#[test]
fn miniapp_host_routing_preserves_existing_primitive_and_allowlist_contract() {
    assert_eq!(split_host_method("fs.readFile"), Some(("fs", "readFile")));
    assert_eq!(split_host_method("shell"), None);

    assert!(is_host_primitive("fs.readFile"));
    assert!(is_host_primitive("shell.exec"));
    assert!(is_host_primitive("os.info"));
    assert!(is_host_primitive("net.fetch"));
    assert!(!is_host_primitive("storage.get"));
    assert!(!is_host_primitive("custom.method"));
    assert!(!is_host_primitive("shell"));

    assert_eq!(
        command_basename_for_allowlist(r"C:\Program Files\Git\cmd\git.exe"),
        "git"
    );
    assert_eq!(command_basename_for_allowlist("git.exe"), "git");
    assert_eq!(command_basename_for_allowlist("/usr/bin/git"), "git");
    assert_eq!(command_basename_for_allowlist("CARGO"), "cargo");

    assert_eq!(fs_method_access_mode("readFile"), FsAccessMode::Read);
    assert_eq!(fs_method_access_mode("writeFile"), FsAccessMode::Write);
    assert_eq!(fs_method_access_mode("access").policy_key(), None);
    let policy = serde_json::json!({
        "fs": {
            "read": ["/workspace", "/tmp/granted"],
            "write": ["/workspace/out"]
        }
    });
    assert_eq!(
        fs_policy_scopes(&policy, FsAccessMode::Read),
        vec!["/workspace".to_string(), "/tmp/granted".to_string()]
    );
    assert!(fs_resolved_path_allowed(
        Path::new("/workspace/src/main.rs"),
        [PathBuf::from("/workspace")]
    ));
    assert!(!fs_resolved_path_allowed(
        Path::new("/workspaced/src/main.rs"),
        [PathBuf::from("/workspace")]
    ));

    let argv = vec!["git".to_string(), "status".to_string()];
    assert_eq!(
        shell_exec_first_token(Some(&argv), "node ignored.js"),
        "git"
    );
    assert_eq!(shell_exec_first_token(None, " cargo test "), "cargo");
    assert!(shell_exec_input_is_empty(Some(&[]), ""));
    assert!(!shell_exec_input_is_empty(Some(&argv), ""));
    assert_eq!(
        shell_exec_cwd(
            Some("/explicit"),
            Some(Path::new("/workspace")),
            Path::new("/appdata")
        ),
        PathBuf::from("/explicit")
    );
    assert_eq!(
        shell_exec_cwd(None, Some(Path::new("/workspace")), Path::new("/appdata")),
        PathBuf::from("/workspace")
    );
    assert_eq!(shell_exec_timeout_ms(None), 30_000);
    assert_eq!(shell_exec_timeout_ms(Some(8_000)), 8_000);
    assert_eq!(
        shell_exec_default_env(),
        [("GIT_TERMINAL_PROMPT", "0"), ("LC_ALL", "C")]
    );

    assert!(!command_basename_allowed(&[], "git"));
    assert!(command_basename_allowed(&["Git".to_string()], "git"));
    assert!(!command_basename_allowed(&["cargo".to_string()], "git"));

    assert!(!host_allowed_by_allowlist(&[], "api.example.com"));
    assert!(host_allowed_by_allowlist(
        &["*".to_string()],
        "api.example.com"
    ));
    assert!(host_allowed_by_allowlist(
        &["example.com".to_string()],
        "api.example.com"
    ));
    assert!(host_allowed_by_allowlist(
        &["api.example.com".to_string()],
        "api.example.com"
    ));
    assert!(!host_allowed_by_allowlist(
        &["example.com".to_string()],
        "badexample.com"
    ));
}

#[test]
fn miniapp_host_fs_call_plans_preserve_existing_path_and_permission_contract() {
    let read = plan_fs_host_call(
        "readFile",
        &serde_json::json!({ "path": "/workspace/read.txt", "encoding": "base64" }),
    )
    .expect("readFile should plan");
    assert_eq!(
        read,
        MiniAppFsHostCallPlan::ReadFile {
            path: PathBuf::from("/workspace/read.txt"),
            encoding_base64: true,
        }
    );
    assert_eq!(
        read.path_checks(),
        vec![MiniAppFsHostPathCheck {
            path: PathBuf::from("/workspace/read.txt"),
            mode: FsAccessMode::Read,
            denied_prefix: "Path",
        }]
    );

    let write = plan_fs_host_call(
        "writeFile",
        &serde_json::json!({ "p": "/workspace/out.txt", "data": "hello" }),
    )
    .expect("legacy p alias should plan");
    assert_eq!(
        write,
        MiniAppFsHostCallPlan::WriteFile {
            path: PathBuf::from("/workspace/out.txt"),
            data: "hello".to_string(),
        }
    );
    assert_eq!(
        write.path_checks(),
        vec![MiniAppFsHostPathCheck {
            path: PathBuf::from("/workspace/out.txt"),
            mode: FsAccessMode::Write,
            denied_prefix: "Path",
        }]
    );

    let copy = plan_fs_host_call(
        "copyFile",
        &serde_json::json!({ "src": "/workspace/src.txt", "dst": "/workspace/dst.txt" }),
    )
    .expect("copyFile should plan source and destination checks");
    assert_eq!(
        copy.path_checks(),
        vec![
            MiniAppFsHostPathCheck {
                path: PathBuf::from("/workspace/src.txt"),
                mode: FsAccessMode::Read,
                denied_prefix: "src",
            },
            MiniAppFsHostPathCheck {
                path: PathBuf::from("/workspace/dst.txt"),
                mode: FsAccessMode::Write,
                denied_prefix: "dst",
            }
        ]
    );

    let rename = plan_fs_host_call(
        "rename",
        &serde_json::json!({ "oldPath": "/workspace/old.txt", "newPath": "/workspace/new.txt" }),
    )
    .expect("rename should plan write checks for old and new paths");
    assert_eq!(
        rename.path_checks(),
        vec![
            MiniAppFsHostPathCheck {
                path: PathBuf::from("/workspace/old.txt"),
                mode: FsAccessMode::Write,
                denied_prefix: "oldPath",
            },
            MiniAppFsHostPathCheck {
                path: PathBuf::from("/workspace/new.txt"),
                mode: FsAccessMode::Write,
                denied_prefix: "newPath",
            }
        ]
    );

    let access = plan_fs_host_call(
        "access",
        &serde_json::json!({ "path": "/workspace/read.txt" }),
    )
    .expect("access should plan without permission checks");
    assert!(access.path_checks().is_empty());

    assert_eq!(
        plan_fs_legacy_path_check(
            "copyFile",
            &serde_json::json!({ "path": "/workspace/legacy.txt" })
        ),
        Some(MiniAppFsHostPathCheck {
            path: PathBuf::from("/workspace/legacy.txt"),
            mode: FsAccessMode::Write,
            denied_prefix: "Path",
        })
    );
    assert_eq!(
        plan_fs_legacy_path_check(
            "unknownMethod",
            &serde_json::json!({ "p": "/workspace/legacy.txt" })
        ),
        Some(MiniAppFsHostPathCheck {
            path: PathBuf::from("/workspace/legacy.txt"),
            mode: FsAccessMode::Read,
            denied_prefix: "Path",
        })
    );
    assert_eq!(
        plan_fs_legacy_path_check("access", &serde_json::json!({ "path": "/workspace/a.txt" })),
        None
    );
}

#[test]
fn miniapp_host_fs_call_plans_preserve_existing_error_contract() {
    let missing_path = plan_fs_host_call("readFile", &serde_json::json!({})).unwrap_err();
    assert_eq!(missing_path.kind(), MiniAppHostPlanErrorKind::Parse);
    assert_eq!(missing_path.message(), "missing path");

    let missing_src = plan_fs_host_call(
        "copyFile",
        &serde_json::json!({ "dst": "/workspace/dst.txt" }),
    )
    .unwrap_err();
    assert_eq!(missing_src.kind(), MiniAppHostPlanErrorKind::Parse);
    assert_eq!(missing_src.message(), "missing param: src");

    let unknown =
        plan_fs_host_call("chmod", &serde_json::json!({ "path": "/workspace/a.txt" })).unwrap_err();
    assert_eq!(unknown.kind(), MiniAppHostPlanErrorKind::Validation);
    assert_eq!(unknown.message(), "unknown fs method: chmod");
}

#[test]
fn miniapp_host_shell_call_plans_preserve_existing_input_and_default_contract() {
    let argv_plan = plan_shell_host_call(
        "exec",
        &serde_json::json!({
            "args": ["git", "rev-parse", "--is-inside-work-tree"],
            "command": "ignored when args exists",
            "cwd": "/workspace",
            "timeout": 8000
        }),
        Some(Path::new("/fallback-workspace")),
        Path::new("/appdata"),
    )
    .expect("argv shell.exec should plan");
    assert_eq!(
        argv_plan,
        MiniAppShellHostCallPlan {
            argv: Some(vec![
                "git".to_string(),
                "rev-parse".to_string(),
                "--is-inside-work-tree".to_string(),
            ]),
            command: "ignored when args exists".to_string(),
            first_token: "git".to_string(),
            cwd: PathBuf::from("/workspace"),
            timeout_ms: 8000,
        }
    );

    let command_plan = plan_shell_host_call(
        "exec",
        &serde_json::json!({ "command": " cargo test " }),
        Some(Path::new("/workspace")),
        Path::new("/appdata"),
    )
    .expect("command shell.exec should plan");
    assert_eq!(command_plan.argv, None);
    assert_eq!(command_plan.command, "cargo test");
    assert_eq!(command_plan.first_token, "cargo");
    assert_eq!(command_plan.cwd, PathBuf::from("/workspace"));
    assert_eq!(command_plan.timeout_ms, 30_000);

    let appdata_plan = plan_shell_host_call(
        "exec",
        &serde_json::json!({ "command": "git status" }),
        None,
        Path::new("/appdata"),
    )
    .expect("missing cwd should fall back to app data dir");
    assert_eq!(appdata_plan.cwd, PathBuf::from("/appdata"));
}

#[test]
fn miniapp_host_shell_call_plans_preserve_existing_error_contract() {
    let empty = plan_shell_host_call(
        "exec",
        &serde_json::json!({ "command": "   " }),
        Some(Path::new("/workspace")),
        Path::new("/appdata"),
    )
    .unwrap_err();
    assert_eq!(empty.kind(), MiniAppHostPlanErrorKind::Parse);
    assert_eq!(empty.message(), "empty command");

    let unknown = plan_shell_host_call(
        "spawn",
        &serde_json::json!({ "command": "git status" }),
        Some(Path::new("/workspace")),
        Path::new("/appdata"),
    )
    .unwrap_err();
    assert_eq!(unknown.kind(), MiniAppHostPlanErrorKind::Validation);
    assert_eq!(unknown.message(), "unknown shell method: spawn");
}

#[test]
fn miniapp_lifecycle_helpers_preserve_runtime_revision_contract() {
    let source = MiniAppSource {
        npm_dependencies: vec![
            NpmDep {
                name: "zeta".to_string(),
                version: "2.0.0".to_string(),
            },
            NpmDep {
                name: "alpha".to_string(),
                version: "^1.0.0".to_string(),
            },
        ],
        ..MiniAppSource::default()
    };

    assert_eq!(build_source_revision(3, 1234), "src:3:1234");
    assert_eq!(build_deps_revision(&source), "alpha@^1.0.0|zeta@2.0.0");

    let runtime = build_runtime_state(3, 1234, &source, true, true);
    assert_eq!(runtime.source_revision, "src:3:1234");
    assert_eq!(runtime.deps_revision, "alpha@^1.0.0|zeta@2.0.0");
    assert!(runtime.deps_dirty);
    assert!(runtime.worker_restart_required);
    assert!(!runtime.ui_recompile_required);

    let mut app = sample_miniapp_for_lifecycle(source);
    assert!(ensure_runtime_state(&mut app));
    assert_eq!(app.runtime.source_revision, "src:3:1234");
    assert_eq!(app.runtime.deps_revision, "alpha@^1.0.0|zeta@2.0.0");
    assert!(!ensure_runtime_state(&mut app));

    assert_eq!(
        build_worker_revision(&app, r#"{"fs":{}}"#),
        r#"src:3:1234::alpha@^1.0.0|zeta@2.0.0::{"fs":{}}"#
    );
    assert_eq!(
        workspace_dir_string(Some(Path::new("/tmp/workspace"))),
        "/tmp/workspace"
    );
    assert_eq!(workspace_dir_string(None), "");
}

#[test]
fn miniapp_lifecycle_manager_state_helpers_preserve_core_transitions() {
    let source = MiniAppSource {
        npm_dependencies: vec![NpmDep {
            name: "lodash".to_string(),
            version: "^4.17.21".to_string(),
        }],
        ..MiniAppSource::default()
    };
    let mut app = sample_miniapp_for_lifecycle(source.clone());

    mark_deps_installed_state(&mut app);
    assert_eq!(app.runtime.source_revision, "src:3:1234");
    assert_eq!(app.runtime.deps_revision, "lodash@^4.17.21");
    assert!(!app.runtime.deps_dirty);
    assert!(app.runtime.worker_restart_required);

    assert!(clear_worker_restart_required_state(&mut app));
    assert!(!app.runtime.worker_restart_required);
    assert!(!clear_worker_restart_required_state(&mut app));

    apply_recompile_result(&mut app, "<html>fresh</html>".to_string(), 2000);
    assert_eq!(app.compiled_html, "<html>fresh</html>");
    assert_eq!(app.updated_at, 2000);
    assert!(!app.runtime.ui_recompile_required);
    assert_eq!(app.runtime.source_revision, "src:3:1234");

    let current = sample_miniapp_for_lifecycle(MiniAppSource::default());
    let rollback_target = sample_miniapp_for_lifecycle(source.clone());
    let rolled_back = prepare_rollback_app(&current, rollback_target, 3000);
    assert_eq!(rolled_back.version, current.version + 1);
    assert_eq!(rolled_back.updated_at, 3000);
    assert!(rolled_back.runtime.deps_dirty);
    assert!(rolled_back.runtime.worker_restart_required);
    assert_eq!(rolled_back.runtime.deps_revision, "lodash@^4.17.21");

    let synced =
        apply_sync_from_fs_result(&current, source, "<html>synced</html>".to_string(), 4000);
    assert_eq!(synced.version, current.version + 1);
    assert_eq!(synced.updated_at, 4000);
    assert_eq!(synced.compiled_html, "<html>synced</html>");
    assert!(synced.runtime.deps_dirty);
    assert!(synced.runtime.worker_restart_required);

    let mut imported = synced.clone();
    imported.runtime.worker_restart_required = false;
    imported.runtime.deps_dirty = false;
    apply_import_runtime_state(&mut imported);
    assert!(imported.runtime.deps_dirty);
    assert!(imported.runtime.worker_restart_required);
    assert_eq!(imported.runtime.source_revision, "src:4:4000");
    assert_eq!(imported.runtime.deps_revision, "lodash@^4.17.21");
}

#[test]
fn miniapp_content_hash_ignores_runtime_artifacts_and_tracks_product_content() {
    let mut app = sample_miniapp_for_lifecycle(MiniAppSource {
        css: "body { color: black; }".to_string(),
        ..MiniAppSource::default()
    });
    let initial_hash = miniapp_content_hash(&app);

    app.version += 1;
    app.updated_at += 1000;
    app.compiled_html = "<html>different runtime artifact</html>".to_string();
    app.runtime.source_revision = "src:99:9999".to_string();
    assert_eq!(miniapp_content_hash(&app), initial_hash);

    app.source.css = "body { color: red; }".to_string();
    assert_ne!(miniapp_content_hash(&app), initial_hash);
}

#[test]
fn miniapp_sync_and_draft_apply_do_not_create_versions_for_unchanged_content() {
    let mut current = sample_miniapp_for_lifecycle(MiniAppSource {
        css: "body { color: black; }".to_string(),
        ..MiniAppSource::default()
    });
    ensure_runtime_state(&mut current);

    let synced = apply_sync_from_fs_result(
        &current,
        current.source.clone(),
        "<html>recompiled</html>".to_string(),
        5000,
    );
    assert_eq!(synced.version, current.version);
    assert_eq!(synced.updated_at, current.updated_at);
    assert_eq!(
        synced.runtime.source_revision,
        current.runtime.source_revision
    );
    assert_eq!(synced.runtime.content_hash, current.runtime.content_hash);
    assert_eq!(synced.compiled_html, "<html>recompiled</html>");

    let applied = apply_draft_to_active(
        &current,
        current.clone(),
        "<html>draft recompiled</html>".to_string(),
        6000,
    );
    assert_eq!(applied.version, current.version);
    assert_eq!(applied.updated_at, current.updated_at);
    assert_eq!(
        applied.runtime.source_revision,
        current.runtime.source_revision
    );
    assert_eq!(applied.runtime.content_hash, current.runtime.content_hash);
    assert_eq!(applied.compiled_html, "<html>draft recompiled</html>");
}

#[test]
fn miniapp_lifecycle_create_and_update_helpers_preserve_manager_contract() {
    let source = MiniAppSource {
        css: "body { color: black; }".to_string(),
        ..MiniAppSource::default()
    };
    let ai_context = MiniAppAiContext {
        original_prompt: "build a dashboard".to_string(),
        conversation_id: Some("conversation-1".to_string()),
        iteration_history: vec!["created".to_string()],
    };

    let created = build_created_app(
        "app-1".to_string(),
        MiniAppCreateInput {
            name: "Demo".to_string(),
            description: "Demo app".to_string(),
            icon: "sparkles".to_string(),
            category: "tools".to_string(),
            tags: vec!["demo".to_string()],
            source: source.clone(),
            permissions: MiniAppPermissions::default(),
            ai_context: Some(ai_context.clone()),
        },
        "<html>created</html>".to_string(),
        1000,
    );

    assert_eq!(created.id, "app-1");
    assert_eq!(created.version, 1);
    assert_eq!(created.created_at, 1000);
    assert_eq!(created.updated_at, 1000);
    assert_eq!(created.compiled_html, "<html>created</html>");
    assert_eq!(
        created.ai_context.as_ref().unwrap().conversation_id,
        ai_context.conversation_id
    );
    assert_eq!(created.runtime.source_revision, "src:1:1000");
    assert!(!created.runtime.deps_dirty);
    assert!(created.runtime.worker_restart_required);
    assert!(created.i18n.is_none());

    let updated_source = MiniAppSource {
        css: "body { color: red; }".to_string(),
        npm_dependencies: vec![NpmDep {
            name: "lodash".to_string(),
            version: "^4.17.21".to_string(),
        }],
        ..source
    };
    let updated_permissions = MiniAppPermissions {
        fs: Some(FsPermissions {
            read: Some(vec!["{workspace}".to_string()]),
            write: None,
        }),
        ..MiniAppPermissions::default()
    };
    let patch = MiniAppUpdatePatch {
        name: Some("Updated".to_string()),
        source: Some(updated_source.clone()),
        permissions: Some(updated_permissions.clone()),
        ..MiniAppUpdatePatch::default()
    };
    assert_eq!(patch.source_for_compile(&created).css, updated_source.css);
    assert!(patch.permissions_for_compile(&created).fs.is_some());

    let updated = apply_update_patch(&created, patch, "<html>updated</html>".to_string(), 2000);

    assert_eq!(updated.name, "Updated");
    assert_eq!(updated.description, created.description);
    assert_eq!(updated.tags, created.tags);
    assert_eq!(
        updated.ai_context.as_ref().unwrap().original_prompt,
        "build a dashboard"
    );
    assert_eq!(updated.version, 2);
    assert_eq!(updated.created_at, 1000);
    assert_eq!(updated.updated_at, 2000);
    assert_eq!(updated.compiled_html, "<html>updated</html>");
    assert_eq!(updated.source.css, "body { color: red; }");
    assert_eq!(
        updated
            .permissions
            .fs
            .as_ref()
            .unwrap()
            .read
            .as_ref()
            .unwrap()[0],
        "{workspace}"
    );
    assert_eq!(updated.runtime.source_revision, "src:2:2000");
    assert_eq!(updated.runtime.deps_revision, "lodash@^4.17.21");
    assert!(updated.runtime.deps_dirty);
    assert!(updated.runtime.worker_restart_required);
    assert!(!updated.runtime.ui_recompile_required);

    let metadata_only = apply_update_patch(
        &updated,
        MiniAppUpdatePatch {
            tags: Some(vec!["metadata".to_string()]),
            ..MiniAppUpdatePatch::default()
        },
        "<html>metadata</html>".to_string(),
        3000,
    );

    assert_eq!(metadata_only.version, 3);
    assert_eq!(metadata_only.updated_at, 3000);
    assert_eq!(metadata_only.tags, vec!["metadata".to_string()]);
    assert_eq!(metadata_only.runtime.source_revision, "src:2:2000");
    assert_eq!(metadata_only.runtime.deps_revision, "lodash@^4.17.21");
    assert!(metadata_only.runtime.deps_dirty);
    assert!(metadata_only.runtime.worker_restart_required);
    assert!(!metadata_only.runtime.ui_recompile_required);
}

#[test]
fn miniapp_lifecycle_draft_helpers_preserve_manager_contract() {
    let mut active = sample_miniapp_for_lifecycle(MiniAppSource {
        css: "body { color: black; }".to_string(),
        ..MiniAppSource::default()
    });
    active.runtime = build_runtime_state(
        active.version,
        active.updated_at,
        &active.source,
        false,
        false,
    );

    let prepared = prepare_draft_app(active.clone(), "<html>draft</html>".to_string(), 2000);

    assert_eq!(prepared.version, active.version);
    assert_eq!(prepared.source.css, "body { color: black; }");
    assert_eq!(prepared.updated_at, 2000);
    assert_eq!(prepared.compiled_html, "<html>draft</html>");
    assert_eq!(prepared.runtime.source_revision, "src:3:1234");
    assert!(!prepared.runtime.worker_restart_required);

    let mut draft_from_fs = prepared.clone();
    draft_from_fs.source = MiniAppSource {
        css: "body { background: white; }".to_string(),
        npm_dependencies: vec![NpmDep {
            name: "lodash".to_string(),
            version: "^4.17.21".to_string(),
        }],
        ..MiniAppSource::default()
    };
    let synced =
        apply_draft_source_sync_result(draft_from_fs, "<html>synced</html>".to_string(), 3000);

    assert_eq!(synced.version, active.version);
    assert_eq!(synced.updated_at, 3000);
    assert_eq!(synced.source.css, "body { background: white; }");
    assert_eq!(synced.runtime.source_revision, "src:3:3000");
    assert_eq!(synced.runtime.deps_revision, "lodash@^4.17.21");
    assert!(synced.runtime.deps_dirty);
    assert!(synced.runtime.worker_restart_required);

    let updated_permissions = MiniAppPermissions {
        fs: Some(FsPermissions {
            read: None,
            write: Some(vec!["{workspace}".to_string()]),
        }),
        ..MiniAppPermissions::default()
    };
    let permissioned = apply_draft_permission_update_result(
        synced.clone(),
        updated_permissions,
        "<html>permissioned</html>".to_string(),
        4000,
    );

    assert_eq!(permissioned.version, active.version);
    assert_eq!(permissioned.updated_at, 4000);
    assert!(permissioned
        .permissions
        .fs
        .as_ref()
        .unwrap()
        .write
        .is_some());
    assert_eq!(permissioned.runtime.source_revision, "src:3:4000");
    assert!(permissioned.runtime.worker_restart_required);

    let mut draft_to_apply = permissioned;
    draft_to_apply.name = "Draft name".to_string();
    draft_to_apply.description = "Draft description".to_string();
    draft_to_apply.i18n = Some(MiniAppI18n::default());

    let applied = apply_draft_to_active(
        &active,
        draft_to_apply,
        "<html>applied</html>".to_string(),
        5000,
    );

    assert_eq!(applied.id, active.id);
    assert_eq!(applied.created_at, active.created_at);
    assert_eq!(applied.version, active.version + 1);
    assert_eq!(applied.updated_at, 5000);
    assert_eq!(applied.name, "Draft name");
    assert_eq!(applied.description, "Draft description");
    assert_eq!(applied.compiled_html, "<html>applied</html>");
    assert!(applied.i18n.is_some());
    assert_eq!(applied.runtime.source_revision, "src:4:5000");
    assert!(applied.runtime.deps_dirty);
    assert!(applied.runtime.worker_restart_required);
}

#[test]
fn miniapp_storage_package_json_contract_remains_stable() {
    let deps = parse_npm_dependencies(
        r#"{
            "name": "miniapp-demo",
            "dependencies": {
                "left-pad": "^1.3.0",
                "local-only": { "workspace": true }
            }
        }"#,
    )
    .unwrap();

    assert!(deps.contains(&NpmDep {
        name: "left-pad".to_string(),
        version: "^1.3.0".to_string(),
    }));
    assert!(deps.contains(&NpmDep {
        name: "local-only".to_string(),
        version: "*".to_string(),
    }));

    let package = build_package_json(
        "demo",
        &[NpmDep {
            name: "lodash".to_string(),
            version: "^4.17.21".to_string(),
        }],
    );

    assert_eq!(package["name"], "miniapp-demo");
    assert_eq!(package["private"], true);
    assert_eq!(package["dependencies"]["lodash"], "^4.17.21");
}

#[test]
fn miniapp_storage_import_fallback_contract_remains_stable() {
    let root = PathBuf::from("/miniapps/incoming");
    let layout = MiniAppImportLayout::new(&root);

    assert_eq!(layout.meta_path(), root.join(META_JSON));
    assert_eq!(layout.source_dir(), root.join(SOURCE_DIR));
    assert_eq!(
        layout.source_file_path(INDEX_HTML),
        root.join(SOURCE_DIR).join(INDEX_HTML)
    );
    assert_eq!(
        layout.required_source_file_paths(),
        vec![
            (INDEX_HTML, root.join(SOURCE_DIR).join(INDEX_HTML)),
            (STYLE_CSS, root.join(SOURCE_DIR).join(STYLE_CSS)),
            (UI_JS, root.join(SOURCE_DIR).join(UI_JS)),
            (WORKER_JS, root.join(SOURCE_DIR).join(WORKER_JS)),
        ]
    );
    assert_eq!(
        layout.esm_dependencies_path(),
        root.join(SOURCE_DIR).join(ESM_DEPS_JSON)
    );
    assert_eq!(layout.package_json_path(), root.join(PACKAGE_JSON));
    assert_eq!(layout.storage_json_path(), root.join(STORAGE_JSON));

    assert_eq!(
        REQUIRED_SOURCE_FILES,
        &[INDEX_HTML, STYLE_CSS, UI_JS, WORKER_JS]
    );
    assert_eq!(EMPTY_ESM_DEPENDENCIES_JSON, "[]");
    assert_eq!(EMPTY_STORAGE_JSON, "{}");
    assert_eq!(
        PLACEHOLDER_COMPILED_HTML,
        "<!DOCTYPE html><html><head><meta charset=\"utf-8\"></head><body>Loading...</body></html>"
    );

    let package = build_package_json("imported-app", &[]);
    assert_eq!(package["name"], "miniapp-imported-app");
    assert_eq!(package["private"], true);
    assert_eq!(package["dependencies"], serde_json::json!({}));

    let fallbacks = build_import_fallbacks("imported-app");
    assert_eq!(fallbacks.esm_dependencies_json, "[]");
    assert_eq!(fallbacks.storage_json, "{}");
    assert_eq!(fallbacks.compiled_html, PLACEHOLDER_COMPILED_HTML);
    assert_eq!(fallbacks.package_json, package);
}

#[test]
fn miniapp_import_bundle_plan_rehomes_meta_and_preserves_fallback_wire_shape() {
    let source_meta_json = serde_json::json!({
        "id": "template-id",
        "name": "Imported",
        "description": "Imported app",
        "icon": "box",
        "category": "utility",
        "tags": ["demo"],
        "version": 7,
        "created_at": 11,
        "updated_at": 12,
        "permissions": {},
        "runtime": {}
    })
    .to_string();

    let plan = build_import_bundle_plan("new-app", &source_meta_json, 1234).unwrap();

    assert_eq!(plan.esm_dependencies_json, "[]");
    assert_eq!(plan.storage_json, "{}");
    assert_eq!(plan.compiled_html, PLACEHOLDER_COMPILED_HTML);
    let meta: serde_json::Value = serde_json::from_str(&plan.meta_json).unwrap();
    assert_eq!(meta["id"], "new-app");
    assert_eq!(meta["name"], "Imported");
    assert_eq!(meta["version"], 7);
    assert_eq!(meta["created_at"], 1234);
    assert_eq!(meta["updated_at"], 1234);

    let package: serde_json::Value = serde_json::from_str(&plan.package_json).unwrap();
    assert_eq!(package["name"], "miniapp-new-app");
    assert_eq!(package["private"], true);
    assert_eq!(package["dependencies"], serde_json::json!({}));
}

#[test]
fn miniapp_import_bundle_plan_preserves_invalid_meta_error_classification() {
    let error = build_import_bundle_plan("new-app", "{", 1234).unwrap_err();

    assert!(matches!(
        error,
        MiniAppImportBundlePlanError::InvalidMeta(_)
    ));
    assert!(error.to_string().starts_with("Invalid meta.json:"));
}

#[test]
fn miniapp_builtin_contract_preserves_seed_marker_and_hash_policy() {
    let app = BuiltinMiniAppBundle {
        id: "builtin-demo",
        version: 2,
        meta_json: r#"{"id":"builtin-demo"}"#,
        html: "<!doctype html><html></html>",
        css: "body { color: red; }",
        ui_js: r#"console.log("ui");"#,
        worker_js: r#"console.log("worker");"#,
        esm_dependencies_json: "[]",
    };
    let content_hash = builtin_content_hash(&app);

    assert_eq!(BUILTIN_INSTALL_MARKER, ".builtin-manifest.json");
    assert_eq!(
        content_hash,
        "sha256:5a2625011813ed9f39eea6875ab96047eb383ac005298ea86ce68e5ac4e79825"
    );

    assert!(should_seed_builtin_app(&app, &content_hash, None));
    assert!(!should_seed_builtin_app(
        &app,
        &content_hash,
        Some(&BuiltinInstallMarker {
            version: 2,
            hash: content_hash.clone(),
        }),
    ));
    assert!(should_seed_builtin_app(
        &app,
        &content_hash,
        Some(&BuiltinInstallMarker {
            version: 1,
            hash: content_hash.clone(),
        }),
    ));
    assert!(should_seed_builtin_app(
        &app,
        &content_hash,
        Some(&BuiltinInstallMarker {
            version: 3,
            hash: "sha256:old".to_string(),
        }),
    ));

    let package = build_builtin_package_json(app.id);
    assert_eq!(package["name"], "miniapp-builtin-demo");
    assert_eq!(package["private"], true);
    assert_eq!(package["dependencies"], serde_json::json!({}));

    let source_files = builtin_source_files(&app);
    assert_eq!(
        source_files,
        [
            (INDEX_HTML, app.html),
            (STYLE_CSS, app.css),
            (UI_JS, app.ui_js),
            (WORKER_JS, app.worker_js),
            (ESM_DEPS_JSON, app.esm_dependencies_json),
        ]
    );
    assert_eq!(
        BUILTIN_PLACEHOLDER_COMPILED_HTML,
        "<!DOCTYPE html><html><body>Loading...</body></html>"
    );
}

#[test]
fn miniapp_builtin_contract_owns_seed_plan_and_marker_wire_shape() {
    let app = BuiltinMiniAppBundle {
        id: "builtin-demo",
        version: 7,
        meta_json: r#"{"id":"builtin-demo"}"#,
        html: "<!doctype html><html></html>",
        css: "body { color: red; }",
        ui_js: r#"console.log("ui");"#,
        worker_js: r#"console.log("worker");"#,
        esm_dependencies_json: "[]",
    };
    let artifacts =
        openbitfun_product_domains::miniapp::builtin::build_builtin_seed_artifacts(&app);
    let marker = build_builtin_install_marker(&app, &artifacts.content_hash);

    assert_eq!(artifacts.marker, marker);
    assert_eq!(
        resolve_builtin_seed_check(&app, Some(&marker)),
        BuiltinSeedCheck::Skip
    );

    let stale_marker = BuiltinInstallMarker {
        version: 7,
        hash: "sha256:stale".to_string(),
    };
    assert_eq!(
        resolve_builtin_seed_check(&app, Some(&stale_marker)),
        BuiltinSeedCheck::NeedsSeed(artifacts.clone())
    );
    assert_eq!(
        resolve_builtin_seed_check(&app, None),
        BuiltinSeedCheck::NeedsSeed(artifacts.clone())
    );
    assert_eq!(
        resolve_builtin_seed_action(artifacts.clone(), true),
        BuiltinSeedAction::PreserveLocalOverride(artifacts.clone())
    );
    assert_eq!(
        resolve_builtin_seed_action(artifacts.clone(), false),
        BuiltinSeedAction::SeedBundle(artifacts.clone())
    );

    let serialized = serialize_builtin_install_marker(&marker).unwrap();
    assert_eq!(
        serialized,
        format!(
            "{{\n  \"version\": 7,\n  \"hash\": \"{}\"\n}}",
            artifacts.content_hash
        )
    );
    assert_eq!(parse_builtin_install_marker(&serialized).unwrap(), marker);
}

#[test]
fn miniapp_builtin_contract_owns_seed_meta_timestamp_policy() {
    let app = BuiltinMiniAppBundle {
        id: "builtin-demo",
        version: 7,
        meta_json: r#"{
            "id": "template-id",
            "name": "Built in",
            "description": "Demo",
            "icon": "box",
            "category": "tools",
            "version": 7,
            "created_at": 1,
            "updated_at": 2
        }"#,
        html: "<!doctype html><html></html>",
        css: "",
        ui_js: "",
        worker_js: "",
        esm_dependencies_json: "[]",
    };

    let fresh_meta = build_builtin_seed_meta(&app, None, 1000).unwrap();
    assert_eq!(fresh_meta.id, "builtin-demo");
    assert_eq!(fresh_meta.created_at, 1000);
    assert_eq!(fresh_meta.updated_at, 1000);

    let existing_meta = r#"{
        "id": "builtin-demo",
        "name": "Existing",
        "description": "Existing",
        "icon": "box",
        "category": "tools",
        "version": 6,
        "created_at": 123,
        "updated_at": 456
    }"#;
    assert_eq!(preserved_builtin_created_at(Some(existing_meta)), Some(123));
    assert_eq!(preserved_builtin_created_at(Some("{not json")), None);
    assert_eq!(preserved_builtin_created_at(None), None);

    let updated_meta = build_builtin_seed_meta(
        &app,
        preserved_builtin_created_at(Some(existing_meta)),
        2000,
    )
    .unwrap();
    assert_eq!(updated_meta.id, "builtin-demo");
    assert_eq!(updated_meta.name, "Built in");
    assert_eq!(updated_meta.created_at, 123);
    assert_eq!(updated_meta.updated_at, 2000);
}

#[test]
fn miniapp_ports_keep_runtime_boundary_lightweight() {
    let decoded: MiniAppInstallDepsRequest = serde_json::from_value(serde_json::json!({
        "appId": "demo",
        "dependencies": [{"name": "lodash", "version": "^4.17.21"}]
    }))
    .unwrap();
    assert_eq!(decoded.app_id, "demo");
    assert_eq!(decoded.dependencies[0].name, "lodash");

    let request = MiniAppInstallDepsRequest {
        app_id: "demo".to_string(),
        dependencies: vec![NpmDep {
            name: "lodash".to_string(),
            version: "^4.17.21".to_string(),
        }],
    };

    let json = serde_json::to_value(&request).unwrap();
    assert_eq!(json["appId"], "demo");
    assert!(json.get("appDir").is_none());
    assert_eq!(json["dependencies"][0]["name"], "lodash");

    let error = MiniAppPortError::new(MiniAppPortErrorKind::RuntimeUnavailable, "missing node");
    let json = serde_json::to_value(error).unwrap();
    assert_eq!(json["kind"], "runtime_unavailable");
    assert_eq!(json["message"], "missing node");

    let port: &dyn MiniAppRuntimePort = &RuntimePortStub;
    let _future = port.detect_runtime();
}

#[test]
fn miniapp_runtime_facade_persists_port_backed_lifecycle_transitions() {
    let mut app = sample_miniapp_for_lifecycle(MiniAppSource {
        css: "body { color: black; }".to_string(),
        npm_dependencies: vec![NpmDep {
            name: "lodash".to_string(),
            version: "^4.17.21".to_string(),
        }],
        ..MiniAppSource::default()
    });
    app.runtime = build_runtime_state(app.version, app.updated_at, &app.source, true, false);
    let storage = StoragePortStub::new(app);
    let facade = MiniAppRuntimeFacade::new(&storage);

    let installed = block_on(facade.mark_deps_installed("demo".to_string())).unwrap();
    assert!(!installed.runtime.deps_dirty);
    assert!(installed.runtime.worker_restart_required);

    let cleared = block_on(facade.clear_worker_restart_required("demo".to_string())).unwrap();
    assert!(!cleared.runtime.worker_restart_required);

    let recompiled = block_on(facade.persist_recompile_result(
        "demo".to_string(),
        "<html>fresh</html>".to_string(),
        2000,
    ))
    .unwrap();
    assert_eq!(recompiled.version, 3);
    assert_eq!(recompiled.compiled_html, "<html>fresh</html>");
    assert!(!recompiled.runtime.ui_recompile_required);

    let synced_source = MiniAppSource {
        css: "body { color: red; }".to_string(),
        npm_dependencies: vec![NpmDep {
            name: "lodash".to_string(),
            version: "^4.17.21".to_string(),
        }],
        ..MiniAppSource::default()
    };
    let synced = block_on(facade.persist_sync_from_fs_result(
        "demo".to_string(),
        synced_source,
        "<html>synced</html>".to_string(),
        3000,
    ))
    .unwrap();
    assert_eq!(synced.version, 4);
    assert_eq!(synced.source.css, "body { color: red; }");
    assert!(synced.runtime.deps_dirty);
    assert!(synced.runtime.worker_restart_required);
    assert_eq!(storage.saved_version_numbers(), vec![3]);

    let rolled_back = block_on(facade.rollback("demo".to_string(), 3, 4000)).unwrap();
    assert_eq!(rolled_back.version, 5);
    assert_eq!(rolled_back.compiled_html, "<html>fresh</html>");
    assert!(rolled_back.runtime.worker_restart_required);
    assert_eq!(storage.saved_version_numbers(), vec![3, 4]);
}

#[test]
fn miniapp_runtime_facade_owns_manager_create_update_draft_and_apply_workflows() {
    let storage = StoragePortStub::new(sample_miniapp_for_lifecycle(MiniAppSource::default()));
    let facade = MiniAppRuntimeFacade::new(&storage);

    let created = block_on(facade.create_app(
        "created".to_string(),
        MiniAppCreateInput {
            name: "Created".to_string(),
            description: "Created app".to_string(),
            icon: "box".to_string(),
            category: "utility".to_string(),
            tags: vec!["created".to_string()],
            source: MiniAppSource {
                css: "body { color: black; }".to_string(),
                ..MiniAppSource::default()
            },
            permissions: MiniAppPermissions::default(),
            ai_context: None,
        },
        "<html>created</html>".to_string(),
        1000,
    ))
    .unwrap();
    assert_eq!(created.id, "created");
    assert_eq!(created.version, 1);
    assert_eq!(storage.current().compiled_html, "<html>created</html>");

    let updated = block_on(facade.persist_update_result_for_app(
        "created".to_string(),
        created.clone(),
        MiniAppUpdatePatch {
            source: Some(MiniAppSource {
                css: "body { color: red; }".to_string(),
                ..MiniAppSource::default()
            }),
            ..MiniAppUpdatePatch::default()
        },
        "<html>updated</html>".to_string(),
        2000,
    ))
    .unwrap();
    assert_eq!(updated.version, 2);
    assert_eq!(updated.source.css, "body { color: red; }");
    assert_eq!(storage.saved_version_numbers(), vec![1]);

    let draft = block_on(facade.persist_draft_for_app(
        "created".to_string(),
        "draft-1".to_string(),
        "/tmp/draft-1".to_string(),
        updated.clone(),
        "<html>draft</html>".to_string(),
        3000,
    ))
    .unwrap();
    assert_eq!(draft.app_id, "created");
    assert_eq!(draft.source_version, 2);
    assert_eq!(draft.draft_root, "/tmp/draft-1");
    assert_eq!(draft.app.compiled_html, "<html>draft</html>");

    let draft = block_on(facade.persist_draft_permission_update_result(
        draft,
        MiniAppPermissions {
            fs: Some(FsPermissions {
                read: Some(vec!["{workspace}".to_string()]),
                write: None,
            }),
            ..MiniAppPermissions::default()
        },
        "<html>permissioned</html>".to_string(),
        3500,
    ))
    .unwrap();
    assert_eq!(draft.updated_at, 3500);
    assert_eq!(draft.app.compiled_html, "<html>permissioned</html>");

    let applied = block_on(facade.apply_loaded_draft(
        updated,
        draft,
        "<html>applied</html>".to_string(),
        MiniAppCustomizationBaseline::UserCreated,
        4000,
    ))
    .unwrap();
    assert_eq!(applied.version, 3);
    assert_eq!(applied.compiled_html, "<html>applied</html>");
    assert_eq!(storage.saved_version_numbers(), vec![1, 2]);

    let metadata = storage
        .customization_metadata("created")
        .expect("customization metadata should be saved");
    assert_eq!(metadata.last_applied_draft_id.as_deref(), Some("draft-1"));
    assert_eq!(metadata.updated_at, 4000);

    block_on(facade.discard_draft("created".to_string(), "draft-1".to_string())).unwrap();
    assert_eq!(
        storage.deleted_drafts(),
        vec![("created".to_string(), "draft-1".to_string())]
    );
}

#[test]
fn miniapp_runtime_facade_owns_import_bundle_recompile_and_runtime_state_workflow() {
    let storage = StoragePortStub::new(sample_miniapp_for_lifecycle(MiniAppSource::default()));
    let import_port = ImportPortStub::new(
        storage.clone(),
        serde_json::json!({
            "id": "legacy-id",
            "name": "Imported",
            "description": "Imported app",
            "icon": "box",
            "category": "utility",
            "tags": ["imported"],
            "version": 99,
            "created_at": 1,
            "updated_at": 2,
            "permissions": {}
        })
        .to_string(),
    );
    let compile_port = CompilePortStub::new();
    let facade = MiniAppRuntimeFacade::new(&storage);

    let imported = block_on(facade.import_from_path(
        &import_port,
        &compile_port,
        MiniAppImportFromPathRequest {
            source_path: PathBuf::from("fixtures/imported"),
            app_id: "imported-id".to_string(),
            appearance_mode: "dark".to_string(),
            workspace_root: Some(PathBuf::from("workspace/project")),
            imported_at: 5000,
            recompiled_at: 6000,
        },
    ))
    .unwrap();

    assert_eq!(imported.id, "imported-id");
    assert_eq!(imported.name, "Imported");
    assert_eq!(imported.compiled_html, "<html>imported-id:dark</html>");
    assert_eq!(
        imported.runtime.source_revision,
        build_source_revision(imported.version, imported.updated_at)
    );
    assert!(!imported.runtime.ui_recompile_required);
    assert_eq!(imported.updated_at, 6000);
    assert_eq!(storage.save_count(), 2);
    assert_eq!(compile_port.calls().len(), 1);
    assert!(compile_port.calls()[0]
        .contains("imported-id|<html><body>imported</body></html>|dark|workspace/project"));

    let writes = import_port.writes();
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].source_path, PathBuf::from("fixtures/imported"));
    assert_eq!(writes[0].app_id, "imported-id");
    let written_meta: serde_json::Value = serde_json::from_str(&writes[0].meta_json).unwrap();
    assert_eq!(written_meta["id"], "imported-id");
    assert_eq!(written_meta["updated_at"], 5000);
    assert_eq!(writes[0].compiled_html, PLACEHOLDER_COMPILED_HTML);
}

#[test]
fn miniapp_runtime_facade_skips_save_when_restart_flag_already_clear() {
    let mut app = sample_miniapp_for_lifecycle(MiniAppSource::default());
    app.runtime = build_runtime_state(app.version, app.updated_at, &app.source, false, false);
    let storage = StoragePortStub::new(app);
    let facade = MiniAppRuntimeFacade::new(&storage);

    let unchanged = block_on(facade.clear_worker_restart_required("demo".to_string())).unwrap();

    assert!(!unchanged.runtime.worker_restart_required);
    assert_eq!(storage.save_count(), 0);
    assert_eq!(storage.current().version, 3);
}

#[test]
fn miniapp_runtime_facade_preserves_storage_errors_without_state_writes() {
    let app = sample_miniapp_for_lifecycle(MiniAppSource::default());
    let storage = StoragePortStub::new(app);
    let facade = MiniAppRuntimeFacade::new(&storage);

    let missing_app = block_on(facade.mark_deps_installed("missing".to_string())).unwrap_err();
    assert_eq!(missing_app.kind, MiniAppPortErrorKind::NotFound);
    assert_eq!(storage.save_count(), 0);
    assert!(storage.saved_version_numbers().is_empty());

    let missing_version = block_on(facade.rollback("demo".to_string(), 99, 4000)).unwrap_err();
    assert_eq!(missing_version.kind, MiniAppPortErrorKind::NotFound);
    assert_eq!(storage.save_count(), 0);
    assert!(storage.saved_version_numbers().is_empty());
}

#[test]
fn miniapp_draft_contract_preserves_manifest_and_response_shape() {
    let app = sample_miniapp_for_lifecycle(MiniAppSource::default());
    let manifest = build_draft_manifest("app-1", "draft-1", 7, 1234);

    assert_eq!(manifest.app_id, "app-1");
    assert_eq!(manifest.draft_id, "draft-1");
    assert_eq!(manifest.source_version, 7);
    assert_eq!(manifest.status, MINIAPP_DRAFT_STATUS_DRAFT);
    assert_eq!(manifest.created_at, 1234);
    assert_eq!(manifest.updated_at, 1234);

    let json = serde_json::to_value(&manifest).unwrap();
    assert_eq!(json["appId"], "app-1");
    assert_eq!(json["draftId"], "draft-1");
    assert_eq!(json["sourceVersion"], 7);

    let response = build_draft_response("/tmp/draft", app, manifest.clone());
    assert_eq!(response.app_id, "app-1");
    assert_eq!(response.draft_root, "/tmp/draft");
    assert_eq!(response.app.id, "demo");

    let mut applied = manifest;
    applied.mark_applied(2345);
    assert_eq!(applied.status, MINIAPP_DRAFT_STATUS_APPLIED);
    assert_eq!(applied.updated_at, 2345);
}

#[test]
fn miniapp_customization_apply_helper_preserves_builtin_override_policy() {
    let metadata = apply_draft_customization_metadata(
        None,
        MiniAppCustomizationBaseline::Builtin {
            builtin_id: "builtin-gomoku".to_string(),
            builtin_version: 4,
        },
        "draft-1",
        1234,
    );

    assert_eq!(
        metadata.origin.kind,
        MiniAppCustomizationOriginKind::Builtin
    );
    assert_eq!(
        metadata.origin.builtin_id.as_deref(),
        Some("builtin-gomoku")
    );
    assert_eq!(metadata.origin.builtin_version, Some(4));
    assert!(metadata.local_override);
    assert_eq!(metadata.last_applied_draft_id.as_deref(), Some("draft-1"));
    assert!(metadata.available_builtin_update.is_none());
    assert_eq!(metadata.updated_at, 1234);

    let updated = apply_draft_customization_metadata(
        Some(metadata),
        MiniAppCustomizationBaseline::Builtin {
            builtin_id: "builtin-gomoku".to_string(),
            builtin_version: 5,
        },
        "draft-2",
        2345,
    );

    assert_eq!(updated.origin.builtin_version, Some(5));
    assert!(updated.local_override);
    assert_eq!(updated.last_applied_draft_id.as_deref(), Some("draft-2"));
    assert!(updated.available_builtin_update.is_none());

    let user_created = MiniAppCustomizationMetadata {
        origin: MiniAppCustomizationOrigin {
            kind: MiniAppCustomizationOriginKind::UserCreated,
            builtin_id: None,
            builtin_version: None,
            market: None,
        },
        local_override: false,
        last_applied_draft_id: None,
        available_builtin_update: None,
        declined_builtin_updates: Vec::new(),
        updated_at: 10,
    };
    let user_created_update = apply_draft_customization_metadata(
        Some(user_created),
        MiniAppCustomizationBaseline::Builtin {
            builtin_id: "builtin-gomoku".to_string(),
            builtin_version: 6,
        },
        "draft-3",
        3456,
    );

    assert_eq!(
        user_created_update.origin.kind,
        MiniAppCustomizationOriginKind::UserCreated
    );
    assert!(!user_created_update.local_override);
    assert_eq!(
        user_created_update.last_applied_draft_id.as_deref(),
        Some("draft-3")
    );
    assert_eq!(user_created_update.updated_at, 3456);
}

#[test]
fn miniapp_customization_builtin_update_policy_preserves_decline_contract() {
    let mut metadata = apply_draft_customization_metadata(
        None,
        MiniAppCustomizationBaseline::Builtin {
            builtin_id: "builtin-gomoku".to_string(),
            builtin_version: 4,
        },
        "draft-1",
        1234,
    );

    let available = mark_builtin_update_available_metadata(metadata, 5, "hash-v5", 2000, false);
    assert!(available.should_surface_update);
    assert!(available.metadata_changed);
    metadata = available.metadata;
    assert_eq!(
        metadata
            .available_builtin_update
            .as_ref()
            .unwrap()
            .source_hash,
        "hash-v5"
    );

    metadata = decline_builtin_update_metadata(
        metadata,
        5,
        "hash-v5",
        2100,
        Some(MiniAppCustomizationLocalSnapshot {
            version: 7,
            updated_at: 2200,
        }),
    );

    assert!(metadata.available_builtin_update.is_none());
    assert_eq!(metadata.updated_at, 2100);
    assert_eq!(metadata.declined_builtin_updates.len(), 1);
    assert_eq!(
        metadata.declined_builtin_updates[0]
            .last_applied_draft_id
            .as_deref(),
        Some("draft-1")
    );
    assert!(declined_builtin_update_needs_local_snapshot(
        &metadata, "hash-v5"
    ));
    assert!(is_current_declined_builtin_update(
        &metadata,
        "hash-v5",
        Some(MiniAppCustomizationLocalSnapshot {
            version: 7,
            updated_at: 2200,
        }),
    ));
    assert!(!is_current_declined_builtin_update(
        &metadata,
        "hash-v5",
        Some(MiniAppCustomizationLocalSnapshot {
            version: 8,
            updated_at: 2200,
        }),
    ));

    let suppressed =
        mark_builtin_update_available_metadata(metadata.clone(), 5, "hash-v5", 2300, true);
    assert!(!suppressed.should_surface_update);
    assert!(!suppressed.metadata_changed);
    assert!(suppressed.metadata.available_builtin_update.is_none());

    let fallback = is_current_declined_builtin_update(&metadata, "hash-v5", None);
    assert!(fallback);
}

#[test]
fn miniapp_customization_decline_policy_updates_existing_and_trims_old_records() {
    let mut metadata = apply_draft_customization_metadata(
        None,
        MiniAppCustomizationBaseline::Builtin {
            builtin_id: "builtin-gomoku".to_string(),
            builtin_version: 4,
        },
        "draft-1",
        1000,
    );

    metadata = decline_builtin_update_metadata(metadata, 5, "hash-v5", 2000, None);
    metadata = decline_builtin_update_metadata(metadata, 5, "hash-v5", 2500, None);
    assert_eq!(metadata.declined_builtin_updates.len(), 1);
    assert_eq!(metadata.declined_builtin_updates[0].declined_at, 2500);

    for idx in 0..=MAX_DECLINED_BUILTIN_UPDATES {
        metadata = decline_builtin_update_metadata(
            metadata,
            6 + idx as u32,
            &format!("hash-{}", idx),
            3000 + idx as i64,
            None,
        );
    }

    assert_eq!(
        metadata.declined_builtin_updates.len(),
        MAX_DECLINED_BUILTIN_UPDATES
    );
    assert!(!metadata
        .declined_builtin_updates
        .iter()
        .any(|record| record.source_hash == "hash-v5"));
}

fn sample_miniapp_for_lifecycle(source: MiniAppSource) -> MiniApp {
    MiniApp {
        id: "demo".to_string(),
        name: "Demo".to_string(),
        description: "Demo app".to_string(),
        icon: "sparkles".to_string(),
        category: "tools".to_string(),
        tags: Vec::new(),
        version: 3,
        created_at: 1,
        updated_at: 1234,
        source,
        compiled_html: "<html></html>".to_string(),
        permissions: MiniAppPermissions::default(),
        ai_context: None,
        runtime: MiniAppRuntimeState::default(),
        runtime_profile: Default::default(),
        i18n: None,
    }
}
