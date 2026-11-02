//! Exercise the Desktop registration used by startup, not only the shared handler.
use super::*;
use axum::{extract::Json, http::HeaderMap, routing::get, Router};
use openbitfun_core::agentic::tools::{
    framework::{Tool, ToolResult, ToolUseContext},
    implementations::PageManageTool,
};
use serde_json::{json, Value};
use std::sync::atomic::AtomicBool;

#[tokio::test]
async fn desktop_page_manage_registration_reaches_the_executing_account() {
    // Registrations are process-wide OnceLocks. Isolate the production registry
    // and account state from other Desktop tests and from the developer's login.
    if std::env::var_os("OPENBITFUN_PAGE_TOOL_TEST_CHILD").is_none() {
        let root = tempfile::tempdir().unwrap();
        let mut command = openbitfun_services_core::process_manager::create_tokio_command(
            std::env::current_exe().unwrap(),
        );
        command.args([
            "api::remote_connect_api::page_tool_tests::desktop_page_manage_registration_reaches_the_executing_account",
            "--exact", "--nocapture",
        ])
            .env("OPENBITFUN_PAGE_TOOL_TEST_CHILD", "1")
            .env("OPENBITFUN_HOME", root.path())
            .env("NO_PROXY", "127.0.0.1,localhost")
            .env("no_proxy", "127.0.0.1,localhost")
            .kill_on_drop(true);
        let output = tokio::time::timeout(std::time::Duration::from_secs(30), command.output())
            .await
            .unwrap()
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed; 0 failed"));
        return;
    }

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let relay_url = format!("http://{}", listener.local_addr().unwrap());
    let page = json!({
        "slug":"demo", "generation":"generation-a", "title":"Desktop Page", "visibility":"private",
        "file_count":1, "total_bytes":5, "created_at":1, "updated_at":2,
        "url_path":"/p/demo", "deployed_version_id":"v1",
    });
    let change_account = Arc::new(AtomicBool::new(false));
    let mutations = Arc::new(AtomicUsize::new(0));
    let app = Router::new()
        .route(
            "/api/pages",
            get({
                let page = page.clone();
                let change_account = change_account.clone();
                move |headers: HeaderMap| {
                    let page = page.clone();
                    let change_account = change_account.clone();
                    async move {
                        assert_eq!(headers["authorization"], "Bearer desktop-pages-token");
                        if change_account.swap(false, Ordering::SeqCst) {
                            ACCOUNT_CONTEXT_GENERATION.fetch_add(1, Ordering::AcqRel);
                        }
                        Json(json!([page]))
                    }
                }
            }),
        )
        .route(
            "/api/pages/demo",
            axum::routing::patch({
                let mutations = mutations.clone();
                move |headers: HeaderMap, Json(request): Json<Value>| {
                    let page = page.clone();
                    let mutations = mutations.clone();
                    async move {
                        assert_eq!(headers["authorization"], "Bearer desktop-pages-token");
                        assert_eq!(
                            request,
                            json!({"expected_generation":"generation-a", "visibility":"public"})
                        );
                        mutations.fetch_add(1, Ordering::SeqCst);
                        let mut page = page;
                        page["visibility"] = json!("public");
                        Json(page)
                    }
                }
            }),
        );
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    *get_account_context().write().await = Some(AccountContextState {
        session: AccountSession::new("desktop-pages-token".into(), "desktop-user".into(), [0; 32]),
        relay_url: relay_url.clone(),
    });
    sync_account_login_capability(true);
    register_page_tool_hosts();
    let tool = PageManageTool::new();
    let context = ToolUseContext {
        tool_call_id: None,
        agent_type: None,
        session_id: None,
        dialog_turn_id: None,
        workspace: None,
        loaded_deferred_tool_specs: Vec::new(),
        primary_model_facts: Default::default(),
        custom_data: HashMap::new(),
        computer_use_host: None,
        runtime_tool_restrictions: Default::default(),
        runtime_handles: Default::default(),
    };
    assert!(tool.is_available_in_context(Some(&context)).await);
    let results = tool
        .call_impl(&json!({"action":"list"}), &context)
        .await
        .unwrap();
    let ToolResult::Result { data, .. } = &results[0] else {
        panic!("expected a Page list")
    };
    assert_eq!(data["pages"][0]["name"], "Desktop Page");
    assert_eq!(data["pages"][0]["url"], format!("{relay_url}/p/demo"));
    assert_eq!(data["pages"][0]["visibility"], "private");
    assert_eq!(data["pages"][0]["updated_at"], 2);

    let permissions = json!({"action":"permissions", "slug":"demo", "visibility":"public"});
    tool.call_impl(&permissions, &context).await.unwrap();
    assert_eq!(mutations.load(Ordering::SeqCst), 1);
    change_account.store(true, Ordering::SeqCst);
    assert!(tool
        .call_impl(&permissions, &context)
        .await
        .unwrap_err()
        .to_string()
        .contains("account context changed"));
    assert_eq!(
        mutations.load(Ordering::SeqCst),
        1,
        "a stale account snapshot cannot continue to mutation"
    );

    sync_account_login_capability(false);
    assert!(!tool.is_available_in_context(Some(&context)).await);
    assert!(tool
        .call_impl(&json!({"action":"list"}), &context)
        .await
        .unwrap_err()
        .to_string()
        .contains("logged-in"));
    server.abort();
}
