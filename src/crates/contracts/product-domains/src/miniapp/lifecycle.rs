//! MiniApp lifecycle revision helpers.

use std::path::{Path, PathBuf};

use crate::miniapp::types::{
    MiniApp, MiniAppAiContext, MiniAppMeta, MiniAppPermissions, MiniAppRuntimeState, MiniAppSource,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone)]
pub struct MiniAppCreateInput {
    pub name: String,
    pub description: String,
    pub icon: String,
    pub category: String,
    pub tags: Vec<String>,
    pub source: MiniAppSource,
    pub permissions: MiniAppPermissions,
    pub ai_context: Option<MiniAppAiContext>,
    pub chrome: Option<crate::miniapp::chrome::MiniAppChrome>,
}

#[derive(Debug, Clone, Default)]
pub struct MiniAppUpdatePatch {
    pub name: Option<String>,
    pub description: Option<String>,
    pub icon: Option<String>,
    pub category: Option<String>,
    pub tags: Option<Vec<String>>,
    pub source: Option<MiniAppSource>,
    pub permissions: Option<MiniAppPermissions>,
    pub ai_context: Option<MiniAppAiContext>,
    pub chrome: Option<crate::miniapp::chrome::MiniAppChrome>,
}

impl MiniAppUpdatePatch {
    pub fn source_for_compile<'a>(&'a self, previous: &'a MiniApp) -> &'a MiniAppSource {
        self.source.as_ref().unwrap_or(&previous.source)
    }

    pub fn permissions_for_compile<'a>(&'a self, previous: &'a MiniApp) -> &'a MiniAppPermissions {
        self.permissions.as_ref().unwrap_or(&previous.permissions)
    }
}

pub fn build_source_revision(version: u32, updated_at: i64) -> String {
    format!("src:{version}:{updated_at}")
}

fn canonical_json(value: Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.into_iter().map(canonical_json).collect()),
        Value::Object(map) => {
            let mut entries = map.into_iter().collect::<Vec<_>>();
            entries.sort_by(|left, right| left.0.cmp(&right.0));
            let mut canonical = serde_json::Map::new();
            for (key, value) in entries {
                canonical.insert(key, canonical_json(value));
            }
            Value::Object(canonical)
        }
        value => value,
    }
}

/// Hash the user-controlled MiniApp content while excluding lifecycle counters,
/// compiled output, and runtime state.
pub fn miniapp_content_hash(app: &MiniApp) -> String {
    let mut payload = json!({
        "name": &app.name,
        "description": &app.description,
        "icon": &app.icon,
        "category": &app.category,
        "tags": &app.tags,
        "source": &app.source,
        "permissions": &app.permissions,
        "aiContext": &app.ai_context,
        "runtimeProfile": app.runtime_profile,
        "i18n": &app.i18n,
    });
    // Keep hashes of legacy apps stable when the new optional field is absent.
    if let Some(chrome) = &app.chrome {
        payload["chrome"] = json!(chrome);
    }
    let payload = canonical_json(payload);
    let encoded = serde_json::to_vec(&payload)
        .expect("MiniApp content consists only of serializable domain fields");
    format!("sha256:{}", hex::encode(Sha256::digest(encoded)))
}

fn refresh_content_hash(app: &mut MiniApp) {
    app.runtime.content_hash = miniapp_content_hash(app);
}

pub fn build_deps_revision(source: &MiniAppSource) -> String {
    let mut deps: Vec<String> = source
        .npm_dependencies
        .iter()
        .map(|dep| format!("{}@{}", dep.name, dep.version))
        .collect();
    deps.sort();
    deps.join("|")
}

pub fn build_runtime_state(
    version: u32,
    updated_at: i64,
    source: &MiniAppSource,
    deps_dirty: bool,
    worker_restart_required: bool,
) -> MiniAppRuntimeState {
    MiniAppRuntimeState {
        source_revision: build_source_revision(version, updated_at),
        content_hash: String::new(),
        deps_revision: build_deps_revision(source),
        deps_dirty,
        worker_restart_required,
        ui_recompile_required: false,
    }
}

pub fn build_created_app(
    id: String,
    input: MiniAppCreateInput,
    compiled_html: String,
    now: i64,
) -> MiniApp {
    let version = 1;
    let runtime = build_runtime_state(
        version,
        now,
        &input.source,
        !input.source.npm_dependencies.is_empty(),
        true,
    );

    let mut app = MiniApp {
        chrome: input.chrome,
        id,
        name: input.name,
        description: input.description,
        icon: input.icon,
        category: input.category,
        tags: input.tags,
        version,
        created_at: now,
        updated_at: now,
        source: input.source,
        compiled_html,
        permissions: input.permissions,
        ai_context: input.ai_context,
        runtime,
        runtime_profile: Default::default(),
        i18n: None,
    };
    refresh_content_hash(&mut app);
    app
}

pub fn apply_update_patch(
    previous: &MiniApp,
    patch: MiniAppUpdatePatch,
    compiled_html: String,
    now: i64,
) -> MiniApp {
    let source_changed = patch.source.is_some();
    let permissions_changed = patch.permissions.is_some();
    let mut app = previous.clone();

    if let Some(name) = patch.name {
        app.name = name;
    }
    if let Some(description) = patch.description {
        app.description = description;
    }
    if let Some(icon) = patch.icon {
        app.icon = icon;
    }
    if let Some(category) = patch.category {
        app.category = category;
    }
    if let Some(tags) = patch.tags {
        app.tags = tags;
    }
    if let Some(source) = patch.source {
        app.source = source;
    }
    if let Some(permissions) = patch.permissions {
        app.permissions = permissions;
    }
    if let Some(chrome) = patch.chrome {
        app.chrome = Some(chrome);
    }
    if let Some(ai_context) = patch.ai_context {
        app.ai_context = Some(ai_context);
    }

    app.version += 1;
    app.updated_at = now;
    app.compiled_html = compiled_html;

    let deps_changed = previous.source.npm_dependencies != app.source.npm_dependencies;
    if source_changed || permissions_changed {
        app.runtime.source_revision = build_source_revision(app.version, app.updated_at);
        app.runtime.worker_restart_required = true;
    }
    if deps_changed {
        app.runtime.deps_revision = build_deps_revision(&app.source);
        app.runtime.deps_dirty = !app.source.npm_dependencies.is_empty();
        app.runtime.worker_restart_required = true;
    }
    app.runtime.ui_recompile_required = false;
    ensure_runtime_state(&mut app);
    refresh_content_hash(&mut app);
    app
}

pub fn prepare_draft_app(mut app: MiniApp, compiled_html: String, now: i64) -> MiniApp {
    app.updated_at = now;
    app.compiled_html = compiled_html;
    ensure_runtime_state(&mut app);
    refresh_content_hash(&mut app);
    app
}

pub fn apply_draft_source_sync_result(
    mut app: MiniApp,
    compiled_html: String,
    now: i64,
) -> MiniApp {
    app.updated_at = now;
    app.compiled_html = compiled_html;
    app.runtime = build_runtime_state(
        app.version,
        app.updated_at,
        &app.source,
        !app.source.npm_dependencies.is_empty(),
        true,
    );
    refresh_content_hash(&mut app);
    app
}

pub fn apply_draft_permission_update_result(
    mut app: MiniApp,
    permissions: MiniAppPermissions,
    compiled_html: String,
    now: i64,
) -> MiniApp {
    app.permissions = permissions;
    app.updated_at = now;
    app.compiled_html = compiled_html;
    app.runtime = build_runtime_state(
        app.version,
        app.updated_at,
        &app.source,
        !app.source.npm_dependencies.is_empty(),
        true,
    );
    refresh_content_hash(&mut app);
    app
}

pub fn apply_draft_to_active(
    current: &MiniApp,
    draft: MiniApp,
    compiled_html: String,
    now: i64,
) -> MiniApp {
    let current_hash = miniapp_content_hash(current);
    let draft_hash = miniapp_content_hash(&draft);
    if current_hash == draft_hash {
        let mut app = current.clone();
        app.compiled_html = compiled_html;
        ensure_runtime_state(&mut app);
        refresh_content_hash(&mut app);
        return app;
    }

    let mut app = current.clone();
    app.name = draft.name;
    app.description = draft.description;
    app.icon = draft.icon;
    app.category = draft.category;
    app.tags = draft.tags;
    app.source = draft.source;
    app.permissions = draft.permissions;
    app.ai_context = draft.ai_context;
    app.i18n = draft.i18n;
    app.chrome = draft.chrome;
    app.version = current.version + 1;
    app.updated_at = now;
    app.compiled_html = compiled_html;
    app.runtime = build_runtime_state(
        app.version,
        app.updated_at,
        &app.source,
        !app.source.npm_dependencies.is_empty(),
        true,
    );
    refresh_content_hash(&mut app);
    app
}

pub fn ensure_runtime_state(app: &mut MiniApp) -> bool {
    let mut changed = false;
    if app.runtime.source_revision.is_empty() {
        app.runtime.source_revision = build_source_revision(app.version, app.updated_at);
        changed = true;
    }
    if app.runtime.content_hash.is_empty() {
        refresh_content_hash(app);
        changed = true;
    }
    let deps_revision = build_deps_revision(&app.source);
    if app.runtime.deps_revision != deps_revision {
        app.runtime.deps_revision = deps_revision;
        changed = true;
    }
    changed
}

pub fn mark_deps_installed_state(app: &mut MiniApp) {
    ensure_runtime_state(app);
    app.runtime.deps_dirty = false;
    app.runtime.worker_restart_required = true;
}

pub fn clear_worker_restart_required_state(app: &mut MiniApp) -> bool {
    ensure_runtime_state(app);
    if app.runtime.worker_restart_required {
        app.runtime.worker_restart_required = false;
        return true;
    }
    false
}

pub fn prepare_rollback_app(current: &MiniApp, mut target: MiniApp, now: i64) -> MiniApp {
    target.version = current.version + 1;
    target.updated_at = now;
    target.runtime = build_runtime_state(
        target.version,
        target.updated_at,
        &target.source,
        !target.source.npm_dependencies.is_empty(),
        true,
    );
    refresh_content_hash(&mut target);
    target
}

pub fn apply_recompile_result(app: &mut MiniApp, compiled_html: String, now: i64) {
    app.compiled_html = compiled_html;
    app.updated_at = now;
    ensure_runtime_state(app);
    app.runtime.ui_recompile_required = false;
}

pub fn apply_sync_from_fs_result(
    previous: &MiniApp,
    source: MiniAppSource,
    compiled_html: String,
    now: i64,
) -> MiniApp {
    let mut app = previous.clone();
    app.source = source;
    app.compiled_html = compiled_html;
    let content_hash = miniapp_content_hash(&app);
    let content_changed =
        previous.runtime.content_hash.is_empty() || previous.runtime.content_hash != content_hash;
    if content_changed {
        app.version += 1;
        app.updated_at = now;
        app.runtime = build_runtime_state(
            app.version,
            app.updated_at,
            &app.source,
            !app.source.npm_dependencies.is_empty(),
            true,
        );
    } else {
        ensure_runtime_state(&mut app);
        app.runtime.ui_recompile_required = false;
    }
    app.runtime.content_hash = content_hash;
    app
}

pub fn apply_import_runtime_state(app: &mut MiniApp) {
    app.runtime = build_runtime_state(
        app.version,
        app.updated_at,
        &app.source,
        !app.source.npm_dependencies.is_empty(),
        true,
    );
    refresh_content_hash(app);
}

pub fn prepare_imported_meta(meta: &mut MiniAppMeta, id: &str, now: i64) {
    meta.id = id.to_string();
    meta.created_at = now;
    meta.updated_at = now;
}

pub fn build_worker_revision(app: &MiniApp, policy_json: &str) -> String {
    format!(
        "{}::{}::{}",
        app.runtime.source_revision, app.runtime.deps_revision, policy_json
    )
}

pub fn workspace_dir_string(workspace_root: Option<&Path>) -> String {
    workspace_root
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_default()
}

pub fn workspace_root_from_input(workspace_path: Option<&str>) -> Option<PathBuf> {
    workspace_path
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
}

pub fn draft_worker_key(app_id: &str, draft_id: &str) -> String {
    format!("{app_id}:draft:{draft_id}")
}

pub fn should_stop_worker_for_runtime_update(app: &MiniApp) -> bool {
    app.runtime.worker_restart_required
}

pub fn should_emit_worker_restarted(
    was_running: bool,
    deps_installed: bool,
    worker_restart_required: bool,
) -> bool {
    !was_running || deps_installed || worker_restart_required
}

pub fn worker_restart_reason(deps_installed: bool) -> &'static str {
    if deps_installed {
        "deps-installed"
    } else {
        "runtime-restart"
    }
}

pub fn miniapp_runtime_event_payload(app: &MiniApp, reason: &str) -> Value {
    json!({
        "id": app.id,
        "name": app.name,
        "version": app.version,
        "updatedAt": app.updated_at,
        "reason": reason,
        "runtime": {
            "sourceRevision": app.runtime.source_revision,
            "contentHash": app.runtime.content_hash,
            "depsRevision": app.runtime.deps_revision,
            "depsDirty": app.runtime.deps_dirty,
            "workerRestartRequired": app.runtime.worker_restart_required,
            "uiRecompileRequired": app.runtime.ui_recompile_required,
        }
    })
}

pub fn miniapp_worker_stopped_payload(app_id: &str, reason: &str) -> Value {
    json!({ "id": app_id, "reason": reason })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepare_imported_meta_rehomes_identity_and_timestamps_without_changing_product_fields() {
        let mut meta = crate::miniapp::types::MiniAppMeta {
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
            permissions: crate::miniapp::types::MiniAppPermissions::default(),
            ai_context: None,
            runtime: Default::default(),
            runtime_profile: Default::default(),
            i18n: None,
        };

        prepare_imported_meta(&mut meta, "new-id", 1234);

        assert_eq!(meta.id, "new-id");
        assert_eq!(meta.created_at, 1234);
        assert_eq!(meta.updated_at, 1234);
        assert_eq!(meta.name, "Imported");
        assert_eq!(meta.description, "Imported app");
        assert_eq!(meta.version, 7);
    }

    #[test]
    fn host_event_helpers_preserve_existing_worker_and_payload_contract() {
        let app = build_created_app(
            "app-1".to_string(),
            MiniAppCreateInput {
                chrome: None,
                name: "App".to_string(),
                description: "Desc".to_string(),
                icon: "box".to_string(),
                category: "utility".to_string(),
                tags: vec![],
                source: MiniAppSource::default(),
                permissions: MiniAppPermissions::default(),
                ai_context: None,
            },
            "<html></html>".to_string(),
            123,
        );

        assert_eq!(
            miniapp_runtime_event_payload(&app, "create"),
            serde_json::json!({
                "id": "app-1",
                "name": "App",
                "version": 1,
                "updatedAt": 123,
                "reason": "create",
                "runtime": {
                    "sourceRevision": "src:1:123",
                    "contentHash": app.runtime.content_hash.clone(),
                    "depsRevision": "",
                    "depsDirty": false,
                    "workerRestartRequired": true,
                    "uiRecompileRequired": false
                }
            })
        );

        assert_eq!(
            miniapp_worker_stopped_payload("app-1", "pending-restart"),
            serde_json::json!({ "id": "app-1", "reason": "pending-restart" })
        );
        assert_eq!(draft_worker_key("app-1", "draft-1"), "app-1:draft:draft-1");
        assert_eq!(
            workspace_root_from_input(Some(" /workspace ")),
            Some(std::path::PathBuf::from("/workspace"))
        );
        assert_eq!(workspace_root_from_input(Some("   ")), None);
        assert_eq!(workspace_root_from_input(None), None);
        assert!(should_stop_worker_for_runtime_update(&app));
        assert!(!should_emit_worker_restarted(true, false, false));
        assert!(should_emit_worker_restarted(false, false, false));
        assert!(should_emit_worker_restarted(true, true, false));
        assert!(should_emit_worker_restarted(true, false, true));
        assert_eq!(worker_restart_reason(true), "deps-installed");
        assert_eq!(worker_restart_reason(false), "runtime-restart");
    }
}
