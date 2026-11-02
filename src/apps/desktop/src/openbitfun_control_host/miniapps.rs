//! ProductControl adapter for the existing MiniApp lifecycle owner.
//!
//! Source travels as data, so remote workspaces and controllers never have to
//! interpret a product-host path as a workspace or controller-local path.

use openbitfun_core::infrastructure::events::{emit_global_event, BackendEvent};
use openbitfun_core::miniapp::lifecycle::{
    miniapp_runtime_event_payload, should_stop_worker_for_runtime_update, MiniAppCreateInput,
    MiniAppUpdatePatch,
};
use openbitfun_core::miniapp::{
    EsmDep, JsWorkerPool, MiniApp, MiniAppManager, MiniAppPermissions, MiniAppSource, NpmDep,
};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Operation {
    List,
    Inspect,
    Create,
    Update,
    Delete,
}

pub(super) fn operation(id: &str) -> Option<Operation> {
    match id {
        "list" => Some(Operation::List),
        "inspect" => Some(Operation::Inspect),
        "create" => Some(Operation::Create),
        "update" => Some(Operation::Update),
        "delete" => Some(Operation::Delete),
        _ => None,
    }
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    app_id: Option<String>,
    expected_version: Option<u32>,
    name: Option<String>,
    description: Option<String>,
    icon: Option<String>,
    category: Option<String>,
    tags: Option<Vec<String>>,
    permissions: Option<MiniAppPermissions>,
    chrome: Option<openbitfun_product_domains::miniapp::chrome::MiniAppChrome>,
    html: Option<String>,
    css: Option<String>,
    ui_js: Option<String>,
    worker_js: Option<String>,
    esm_dependencies: Option<Vec<EsmDep>>,
    npm_dependencies: Option<Vec<NpmDep>>,
}

impl Input {
    fn patch_source(&mut self, mut source: MiniAppSource) -> MiniAppSource {
        if let Some(value) = self.html.take() {
            source.html = value;
        }
        if let Some(value) = self.css.take() {
            source.css = value;
        }
        if let Some(value) = self.ui_js.take() {
            source.ui_js = value;
        }
        if let Some(value) = self.worker_js.take() {
            source.worker_js = value;
        }
        if let Some(value) = self.esm_dependencies.take() {
            source.esm_dependencies = value;
        }
        if let Some(value) = self.npm_dependencies.take() {
            source.npm_dependencies = value;
        }
        source
    }
}

fn editable_app(app: &MiniApp) -> Value {
    json!({
        "appId": app.id, "version": app.version, "name": app.name,
        "description": app.description, "icon": app.icon, "category": app.category,
        "tags": app.tags, "permissions": app.permissions, "chrome": app.chrome,
        "html": app.source.html, "css": app.source.css, "uiJs": app.source.ui_js,
        "workerJs": app.source.worker_js, "esmDependencies": app.source.esm_dependencies,
        "npmDependencies": app.source.npm_dependencies,
        "contentHash": app.runtime.content_hash, "sourceRevision": app.runtime.source_revision,
    })
}

pub(super) async fn execute(
    manager: &MiniAppManager,
    pool: Option<&JsWorkerPool>,
    operation: Operation,
    arguments: Option<&Value>,
) -> Result<Value, String> {
    let mut input: Input = serde_json::from_value(arguments.cloned().unwrap_or_else(|| json!({})))
        .map_err(|error| format!("Invalid MiniApp arguments: {error}"))?;
    if input
        .name
        .as_ref()
        .is_some_and(|name| name.trim().is_empty())
    {
        return Err("MiniApp name cannot be empty".to_string());
    }
    if operation == Operation::List {
        return Ok(
            json!({ "apps": manager.list().await.map_err(|error| error.to_string())?, "readBack": true }),
        );
    }
    let previous = if operation != Operation::Create {
        let id = input.app_id.as_deref().ok_or("appId is required")?;
        // Resolve an installed identity before any path-based owner call. This
        // also rejects traversal and mistyped IDs without touching user data.
        if !manager
            .list()
            .await
            .map_err(|error| error.to_string())?
            .iter()
            .any(|app| app.id == id)
        {
            return Err(format!("MiniApp is not installed: {id}"));
        }
        let app = manager.get(id).await.map_err(|error| error.to_string())?;
        if input
            .expected_version
            .is_some_and(|version| version != app.version)
        {
            return Err(format!("MiniApp changed since inspection; current version is {}. Inspect it again before editing or deleting", app.version));
        }
        Some(app)
    } else {
        None
    };
    if operation == Operation::Inspect {
        return Ok(json!({ "app": editable_app(previous.as_ref().unwrap()), "readBack": true }));
    }
    if operation == Operation::Delete {
        let app = previous.unwrap();
        if let Some(pool) = pool {
            pool.stop(&app.id).await;
        }
        manager
            .delete(&app.id)
            .await
            .map_err(|error| error.to_string())?;
        let delivered = emit_global_event(BackendEvent::Custom {
            event_name: "miniapp-deleted".into(),
            payload: json!({ "id": app.id, "reason": "product-control" }),
        })
        .await
        .is_ok();
        return Ok(
            json!({ "appId": app.id, "deleted": true, "readBack": true, "runtimeNotified": delivered }),
        );
    }
    let source = input.patch_source(
        previous
            .as_ref()
            .map(|app| app.source.clone())
            .unwrap_or_else(|| MiniAppSource {
                html: "<!doctype html><html><body><div id=\"app\"></div></body></html>".into(),
                ..Default::default()
            }),
    );
    let app = if let Some(previous) = previous {
        manager
            .update_with_patch(
                &previous.id,
                MiniAppUpdatePatch {
                    name: input.name,
                    description: input.description,
                    icon: input.icon,
                    category: input.category,
                    tags: input.tags,
                    source: Some(source),
                    permissions: input.permissions,
                    chrome: input.chrome,
                    ai_context: None,
                },
                None,
            )
            .await
    } else {
        manager
            .create_with_input(
                MiniAppCreateInput {
                    name: input.name.ok_or("name is required")?,
                    description: input.description.unwrap_or_default(),
                    icon: input.icon.unwrap_or_else(|| "app-window".into()),
                    category: input.category.unwrap_or_else(|| "utility".into()),
                    tags: input.tags.unwrap_or_default(),
                    source,
                    permissions: input.permissions.unwrap_or_default(),
                    chrome: input.chrome,
                    ai_context: None,
                },
                None,
            )
            .await
    }
    .map_err(|error| error.to_string())?;
    if should_stop_worker_for_runtime_update(&app) {
        if let Some(pool) = pool {
            pool.stop(&app.id).await;
        }
    }
    let event_name = if operation == Operation::Create {
        "miniapp-created"
    } else {
        "miniapp-updated"
    };
    let delivered = emit_global_event(BackendEvent::Custom {
        event_name: event_name.into(),
        payload: miniapp_runtime_event_payload(&app, "product-control"),
    })
    .await
    .is_ok();
    Ok(json!({ "app": editable_app(&app), "readBack": true, "runtimeNotified": delivered }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installed_miniapp_crud_uses_isolated_product_storage() {
        let root = tempfile::tempdir().unwrap();
        let output = openbitfun_core::util::process_manager::create_command(
            std::env::current_exe().unwrap(),
        )
        .args([
            "--ignored",
            "--exact",
            "openbitfun_control_host::miniapps::tests::isolated_crud_child",
            "--nocapture",
        ])
        .env("OPENBITFUN_CREATION_CRUD_TEST", "1")
        .env("OPENBITFUN_USER_ROOT", root.path().join("user"))
        .env("OPENBITFUN_HOME", root.path().join("home"))
        .env("OPENBITFUN_E2E_STORAGE_GUARD", "1")
        .output()
        .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[tokio::test]
    #[ignore = "Invoked by installed_miniapp_crud_uses_isolated_product_storage with isolated roots"]
    async fn isolated_crud_child() {
        assert_eq!(
            std::env::var("OPENBITFUN_CREATION_CRUD_TEST").as_deref(),
            Ok("1")
        );
        let paths =
            std::sync::Arc::new(openbitfun_core::infrastructure::PathManager::new().unwrap());
        let manager = MiniAppManager::new(paths.clone());
        let created = execute(
            &manager,
            None,
            Operation::Create,
            Some(&json!({
                "name": "Creative test", "html": "<div id=\"counter\">Ready</div>",
                "uiJs": "document.querySelector('#counter').textContent = 'Working';",
                "chrome": {"titlebar":{"title":"Created window"}}
            })),
        )
        .await
        .unwrap();
        assert_eq!(
            created["app"]["chrome"]["titlebar"]["title"],
            "Created window"
        );
        let id = created["app"]["appId"].as_str().unwrap();
        let version = created["app"]["version"].as_u64().unwrap();
        manager.set_storage(id, "counter", json!(42)).await.unwrap();
        assert!(paths.miniapp_dir(id).join("compiled.html").is_file());
        assert_eq!(
            execute(&manager, None, Operation::List, None)
                .await
                .unwrap()["apps"]
                .as_array()
                .unwrap()
                .len(),
            1
        );

        // Existing installs lack newer metadata fields. Read them without
        // resetting the app or its storage, then edit through the same owner.
        let meta_path = paths.miniapp_dir(id).join("meta.json");
        let mut meta: Value = serde_json::from_slice(&std::fs::read(&meta_path).unwrap()).unwrap();
        for field in ["runtime", "runtime_profile", "i18n", "chrome"] {
            meta.as_object_mut().unwrap().remove(field);
        }
        std::fs::write(&meta_path, serde_json::to_vec(&meta).unwrap()).unwrap();
        let inspected = execute(
            &manager,
            None,
            Operation::Inspect,
            Some(&json!({"appId": id})),
        )
        .await
        .unwrap();
        assert_eq!(inspected["app"]["html"], "<div id=\"counter\">Ready</div>");
        assert!(inspected["app"].get("compiled_html").is_none());
        let updated = execute(
            &manager,
            None,
            Operation::Update,
            Some(&json!({
                "appId": id, "expectedVersion": version, "css": "#counter { padding: 12px; }",
                "chrome": {"titlebar":{"title":"Updated window"}}
            })),
        )
        .await
        .unwrap();
        assert_eq!(updated["app"]["version"], version + 1);
        assert_eq!(
            updated["app"]["chrome"]["titlebar"]["title"],
            "Updated window"
        );
        assert_eq!(updated["app"]["uiJs"], created["app"]["uiJs"]);
        assert_eq!(manager.get_storage(id, "counter").await.unwrap(), json!(42));
        assert!(execute(
            &manager,
            None,
            Operation::Update,
            Some(&json!({"appId": id, "expectedVersion": version, "name": "stale"}))
        )
        .await
        .unwrap_err()
        .contains("changed since inspection"));
        assert!(execute(
            &manager,
            None,
            Operation::Delete,
            Some(&json!({"appId": "../outside"}))
        )
        .await
        .is_err());
        assert!(paths.miniapp_dir(id).exists());
        let deleted = execute(
            &manager,
            None,
            Operation::Delete,
            Some(&json!({"appId": id, "expectedVersion": version + 1})),
        )
        .await
        .unwrap();
        assert_eq!(deleted["deleted"], true);
        assert!(!paths.miniapp_dir(id).exists());
    }
}
