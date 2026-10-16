//! Exercise the public envelope and real action dispatcher, with only host IO replaced.
use super::*;
use crate::agentic::tools::browser_control::builtin_browser::{
    publish_builtin_browser_page_load, set_builtin_browser_host, BuiltInBrowserCommand,
    BuiltInBrowserHost, BuiltInBrowserTarget, TEST_HOST_LOCK,
};
use std::sync::Mutex;

#[derive(Default)]
struct BrowserFixture {
    pages: Mutex<Vec<BuiltInBrowserTarget>>,
    opens: Mutex<Vec<BuiltInBrowserOpenRequest>>,
    commands: Mutex<Vec<BuiltInBrowserCommand>>,
    snapshot_error: Mutex<bool>,
    navigation_error: Mutex<bool>,
    discovery_error: Mutex<bool>,
    fetch_response: Mutex<Value>,
}

#[async_trait]
impl BuiltInBrowserHost for BrowserFixture {
    async fn open(
        &self,
        request: BuiltInBrowserOpenRequest,
    ) -> Result<BuiltInBrowserTarget, String> {
        let mut pages = self.pages.lock().unwrap();
        let target = BuiltInBrowserTarget {
            id: format!("embedded-browser-panel-view-fixture-{}", pages.len()),
            url: request.url.clone(),
            title: "Fixture".into(),
            active: true,
        };
        self.opens.lock().unwrap().push(request);
        pages.push(target.clone());
        Ok(target)
    }

    async fn list_targets(&self) -> Result<Vec<BuiltInBrowserTarget>, String> {
        if *self.discovery_error.lock().unwrap() {
            return Err("fixture discovery failed".into());
        }
        Ok(self.pages.lock().unwrap().clone())
    }

    async fn execute(&self, command: BuiltInBrowserCommand) -> Result<Value, String> {
        self.commands.lock().unwrap().push(command.clone());
        let mut pages = self.pages.lock().unwrap();
        let page = pages
            .iter_mut()
            .find(|p| p.id == command.target_id)
            .ok_or("page closed")?;
        let params = command.params.unwrap_or(json!({}));
        match command.method.as_str() {
            "Page.navigate" => {
                if *self.navigation_error.lock().unwrap() {
                    return Ok(json!({"errorText":"net::ERR_NAME_NOT_RESOLVED"}));
                }
                page.url = params["url"].as_str().unwrap().to_string();
                publish_builtin_browser_page_load(&page.id, "finished", &page.url);
                Ok(json!({"frameId":page.id}))
            }
            "Runtime.evaluate" => {
                let expression = params["expression"].as_str().unwrap_or("");
                let value = if expression.contains("offscreen_count") {
                    if *self.snapshot_error.lock().unwrap() {
                        return Err("fixture observation failed".into());
                    }
                    json!({"url":page.url,"title":page.title,"elements":[{"ref":"e1","tag":"button","text":"Continue"}],"offscreen_count":0,"cross_origin_frames":0}).to_string().into()
                } else if expression.contains("document.readyState") {
                    json!(true)
                } else if expression.contains("publishedTime") {
                    json!({"title":page.title,"url":page.url,"excerpt":"Short excerpt", "textContent":format!("{} BODY_AFTER_EXCERPT", "content ".repeat(100))})
                } else if expression.contains("await fetch(") {
                    json!(self.fetch_response.lock().unwrap().to_string())
                } else if expression.contains("location.href") {
                    json!(page.url)
                } else if expression.contains("document.title") {
                    json!(page.title)
                } else {
                    json!(true)
                };
                Ok(json!({"result":{"value":value}}))
            }
            "Page.close" => {
                pages.retain(|p| p.id != command.target_id);
                Ok(json!({}))
            }
            "Page.captureScreenshot" => Ok(json!({"data":""})),
            _ => Ok(json!({})),
        }
    }
}

fn context(owner: &str) -> ToolUseContext {
    let mut context = ToolUseContext::for_tool_listing(None, None);
    context.session_id = Some(owner.to_string());
    context
}

async fn call(action: &str, params: Value, context: &ToolUseContext) -> (Value, String) {
    let results = ControlHubTool::new()
        .call_impl(
            &json!({"domain":"browser","action":action,"params":params}),
            context,
        )
        .await
        .unwrap();
    match &results[0] {
        ToolResult::Result {
            data,
            result_for_assistant,
            ..
        } => (
            data.clone(),
            result_for_assistant.clone().unwrap_or_default(),
        ),
        other => panic!("unexpected result: {other:?}"),
    }
}

#[tokio::test]
async fn cold_navigation_observes_once_and_keeps_conversations_on_their_pages() {
    let _guard = TEST_HOST_LOCK.lock().await;
    let host = Arc::new(BrowserFixture::default());
    set_builtin_browser_host(host.clone());
    let a = context("browser-workflow-a");
    let b = context("browser-workflow-b");
    let (first, text) = call(
        "navigate",
        json!({"url":"example.com","observe":"article"}),
        &a,
    )
    .await;
    assert_eq!(first["ok"], true, "{first}");
    assert_eq!(first["data"]["created"], true);
    assert_eq!(first["data"]["loaded"], true);
    assert!(text.contains("BODY_AFTER_EXCERPT"));
    assert_eq!(host.opens.lock().unwrap().len(), 1);
    assert!(!host
        .commands
        .lock()
        .unwrap()
        .iter()
        .any(|c| c.method == "Page.navigate"));

    let (second, snapshot) = call(
        "navigate",
        json!({"url":"https://example.com/next","observe":"snapshot"}),
        &a,
    )
    .await;
    assert_eq!(second["data"]["session_id"], first["data"]["session_id"]);
    assert_eq!(second["data"]["created"], false);
    assert!(snapshot.contains("Continue"));
    assert_eq!(host.opens.lock().unwrap().len(), 1);
    let (other, _) = call("navigate", json!({"url":"https://other.example"}), &b).await;
    assert_ne!(other["data"]["session_id"], first["data"]["session_id"]);
    let (unselected, _) = call(
        "get_url",
        json!({"target":"builtin"}),
        &context("unselected-browser-task"),
    )
    .await;
    assert_eq!(unselected["error"]["code"], "WRONG_TAB");
    assert!(host
        .opens
        .lock()
        .unwrap()
        .iter()
        .all(|r| !r.replace_existing));
    let (followup, followup_text) = call("get_url", json!({}), &a).await;
    assert_eq!(followup["data"]["url"], "https://example.com/next");
    assert!(followup_text.contains(first["data"]["session_id"].as_str().unwrap()));

    let (stale, _) = call(
        "navigate",
        json!({"url":"https://example.com","session_id":"embedded-browser-panel-view-missing"}),
        &a,
    )
    .await;
    assert_eq!(stale["error"]["code"], "WRONG_TAB");
    assert_eq!(host.opens.lock().unwrap().len(), 2);
    call("close", json!({}), &a).await;
    let (closed, _) = call("get_url", json!({}), &a).await;
    assert_eq!(closed["error"]["code"], "WRONG_TAB");
    assert_eq!(host.pages.lock().unwrap().len(), 1);
    release_browser_selection("browser-workflow-a").await;
    release_browser_selection("browser-workflow-b").await;
}

#[tokio::test]
async fn navigation_observation_and_fetch_failures_keep_partial_evidence() {
    let _guard = TEST_HOST_LOCK.lock().await;
    let host = Arc::new(BrowserFixture::default());
    set_builtin_browser_host(host.clone());
    let ctx = context("browser-workflow-errors");
    *host.snapshot_error.lock().unwrap() = true;
    let (opened, text) = call(
        "navigate",
        json!({"target":"builtin","url":"https://example.com","observe":"snapshot"}),
        &ctx,
    )
    .await;
    assert_eq!(opened["ok"], true);
    assert!(opened["data"]["observation_error"].is_object());
    assert!(text.contains("observation_error"));
    assert_eq!(host.opens.lock().unwrap().len(), 1);
    *host.navigation_error.lock().unwrap() = true;
    let (failed, text) = call("navigate", json!({"url":"https://invalid.example"}), &ctx).await;
    assert_eq!(failed["ok"], false);
    assert!(text.contains("ERR_NAME_NOT_RESOLVED"));
    assert!(
        text.contains("Inspect"),
        "recovery hints must reach the model"
    );
    assert_eq!(
        host.commands
            .lock()
            .unwrap()
            .iter()
            .filter(|c| c.method == "Page.navigate")
            .count(),
        1
    );

    *host.fetch_response.lock().unwrap() = json!({"error":"CORS blocked"});
    let (cors, text) = call("fetch", json!({"url":"https://other.example"}), &ctx).await;
    assert_eq!(cors["ok"], false);
    assert_eq!(cors["error"]["code"], "NOT_AVAILABLE");
    assert!(text.contains("CORS blocked"));
    *host.fetch_response.lock().unwrap() = json!({"status":503,"status_text":"Unavailable","ok":false,"body":"Retry after maintenance"});
    let (http, text) = call("fetch", json!({"url":"https://example.com/api"}), &ctx).await;
    assert_eq!(http["data"]["result"]["status"], 503);
    assert!(text.contains("503") && text.contains("Retry after maintenance"));
    release_browser_selection("browser-workflow-errors").await;
}

#[tokio::test]
async fn browser_validation_and_remote_gate_run_before_host_io() {
    let _guard = TEST_HOST_LOCK.lock().await;
    let host = Arc::new(BrowserFixture::default());
    set_builtin_browser_host(host.clone());
    let mut ctx = context("browser-workflow-remote");
    for (action, params) in [
        ("navigate", json!({"target":"builtin","url":"https://"})),
        (
            "navigate",
            json!({"url":"https://example.com","observe":"guess"}),
        ),
        (
            "navigate",
            json!({"url":"https://example.com","port":65536}),
        ),
        ("not_an_action", json!({})),
    ] {
        let (invalid, _) = call(action, params, &ctx).await;
        assert_eq!(invalid["error"]["code"], "INVALID_PARAMS", "{invalid}");
    }
    let identity = openbitfun_services_core::workspace_identity::workspace_session_identity(
        "/srv/project",
        Some("browser-ssh"),
        Some("ssh.fixture"),
    )
    .unwrap();
    ctx.workspace = Some(crate::agentic::WorkspaceBinding::new_remote(
        None,
        "/srv/project".into(),
        "browser-ssh".into(),
        "Fixture".into(),
        identity,
    ));
    for action in [
        "navigate",
        "open_builtin",
        "snapshot",
        "list_pages",
        "connect",
    ] {
        let (blocked, _) = call(action, json!({"url":"https://example.com"}), &ctx).await;
        assert_eq!(blocked["error"]["code"], "NOT_AVAILABLE");
    }
    assert!(host.opens.lock().unwrap().is_empty());
    assert!(host.commands.lock().unwrap().is_empty());
    let (wait, _) = call("wait", json!({"duration_ms":0}), &ctx).await;
    assert_eq!(wait["ok"], true);
    let caps = ControlHubTool::new()
        .dispatch("meta", "capabilities", &json!({}), &ctx)
        .await
        .unwrap()[0]
        .content();
    assert_eq!(caps["domains"]["browser"]["available"], false);
    assert_eq!(
        caps["domains"]["browser"]["targets"]["builtin"]["session_count"],
        0
    );
}

#[tokio::test]
async fn legacy_open_survives_external_disconnect_and_discovery_failure_is_not_empty_success() {
    let _guard = TEST_HOST_LOCK.lock().await;
    let host = Arc::new(BrowserFixture::default());
    set_builtin_browser_host(host.clone());
    let ctx = context("browser-workflow-legacy");
    CdpClient::suppress_browser_connection(29183).await;
    let old_payload = r#"{"url":"example.com","port":29183,"replaceExisting":false}"#;
    let params: Value = serde_json::from_str(old_payload).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&params.to_string()).unwrap(),
        params
    );
    let (opened, _) = call("open_builtin", params, &ctx).await;
    assert_eq!(opened["ok"], true, "{opened}");
    assert_eq!(opened["data"]["observable_by_agent"], true);
    assert_eq!(opened["data"]["replace_existing"], false);
    assert_eq!(host.opens.lock().unwrap().len(), 1);
    *host.discovery_error.lock().unwrap() = true;
    let caps = ControlHubTool::new()
        .dispatch("meta", "capabilities", &json!({}), &ctx)
        .await
        .unwrap()[0]
        .content();
    assert!(
        caps["domains"]["browser"]["targets"]["builtin"]["discovery_error"]
            .as_str()
            .unwrap()
            .contains("fixture discovery failed")
    );
    let (failed, _) = call("navigate", json!({"url":"https://example.com"}), &ctx).await;
    assert_eq!(failed["ok"], false);
    assert_eq!(
        host.opens.lock().unwrap().len(),
        1,
        "failed discovery must not create a duplicate page"
    );
    CdpClient::allow_browser_connection(29183).await;
    release_browser_selection("browser-workflow-legacy").await;
}

#[test]
fn partial_cookie_failure_and_unavailable_images_are_not_success_envelopes() {
    for data in [
        json!({"success":false,"set":1,"errors":[{"error":"cookie rejected"}]}),
        json!({"success":false,"screenshot_unavailable":true}),
    ] {
        let wrapped = envelope_wrap_results(
            "browser",
            "fixture",
            vec![ToolResult::ok(data.clone(), Some("Partial output".into()))],
        );
        let result = wrapped[0].content();
        assert_eq!(result["ok"], false);
        assert_eq!(result["data"], data);
        assert!(result["error"]["hints"][0]
            .as_str()
            .unwrap()
            .contains("Do not replay"));
    }
}

#[test]
fn renderer_keeps_recovery_hints_and_article_truncation_visible() {
    let error = json!({"ok":false,"error":{"code":"STALE_REF","message":"Reference expired","hints":["Take a fresh snapshot"]}});
    assert!(ControlHubTool::new()
        .render_result_for_assistant(&error)
        .contains("Take a fresh snapshot"));
    let text = article_summary(
        &json!({"article":{"title":"Article","url":"https://example.com","textContent":"中".repeat(21000)}}),
    );
    assert!(text.contains("truncated"));
    assert!(text.len() < 65000);
}

#[tokio::test]
async fn external_browser_is_invisible_until_user_grants_access_and_disconnect_revokes_it() {
    let port = 29184;
    let ctx = context("external-permission-test");
    assert!(CdpClient::authorized_browser_kind(port).await.is_none());
    for action in [
        "connect",
        "navigate",
        "list_pages",
        "tab_query",
        "tab_new",
        "snapshot",
    ] {
        let (result, text) = call(
            action,
            json!({"target":"external","port":port,"url":"https://example.com"}),
            &ctx,
        )
        .await;
        assert_eq!(result["error"]["code"], "NOT_AVAILABLE", "{result}");
        assert!(text.contains("Settings > Browser Control"));
    }
    // Clearing a Disconnect latch starts the Settings flow; it isn't approval.
    CdpClient::allow_browser_connection(port).await;
    assert!(CdpClient::authorized_browser_kind(port).await.is_none());
    CdpClient::authorize_legacy_browser(port, &BrowserKind::Edge).await;
    assert_eq!(
        CdpClient::authorized_browser_kind(port).await,
        Some(BrowserKind::Edge)
    );
    let (wrong_browser, _) = call(
        "connect",
        json!({"target":"external","port":port,"browser":"chrome"}),
        &ctx,
    )
    .await;
    assert_eq!(wrong_browser["error"]["code"], "INVALID_PARAMS");
    disconnect_external_browser(port).await;
    assert!(CdpClient::authorized_browser_kind(port).await.is_none());
    let (denied, text) = call("list_pages", json!({"target":"external","port":port}), &ctx).await;
    assert_eq!(denied["error"]["code"], "NOT_AVAILABLE");
    assert!(!text.contains("use ComputerUse"));
    CdpClient::allow_browser_connection(port).await;
    assert!(CdpClient::authorized_browser_kind(port).await.is_none());
}

#[tokio::test]
#[ignore = "requires disposable Chromium and HTTP fixtures; run scripts/test-browser-workflow.mjs"]
async fn real_browser_workflow() {
    let port: u16 = std::env::var("OPENBITFUN_BROWSER_TEST_PORT")
        .unwrap()
        .parse()
        .unwrap();
    let url = std::env::var("OPENBITFUN_BROWSER_TEST_URL").unwrap();
    let ctx = context("real-browser-workflow");
    let (unapproved, _) = call("list_pages", json!({"target":"external","port":port}), &ctx).await;
    assert_eq!(unapproved["error"]["code"], "NOT_AVAILABLE");
    // The fixture stands in for Settings completing browser-owned approval.
    // No actual user's browser/profile or permission prompt is touched.
    CdpClient::connect_user_profile_browser(
        port,
        port,
        &BrowserKind::Chrome,
        &std::env::var("OPENBITFUN_BROWSER_TEST_WS").unwrap(),
    )
    .await
    .unwrap();
    let (attached, _) = call("connect", json!({"target":"external","port":port,"target_title":"Unrelated fixture tab","activate":false}), &ctx).await;
    assert_eq!(attached["ok"], true, "{attached}");
    assert_eq!(attached["data"]["browser_profile"], "current_user");
    let (inventory, _) = call("list_pages", json!({}), &ctx).await;
    assert_eq!(inventory["ok"], true);
    disconnect_external_browser(port).await;
    let (revoked, _) = call("snapshot", json!({"target":"external","port":port}), &ctx).await;
    assert_eq!(revoked["error"]["code"], "NOT_AVAILABLE");
    CdpClient::allow_browser_connection(port).await;
    browser_sessions()
        .release_selection("real-browser-workflow")
        .await;
    let (opened, snapshot) = call(
        "navigate",
        json!({"target":"external","mode":"headless","port":port,"url":url,"observe":"snapshot"}),
        &ctx,
    )
    .await;
    assert_eq!(opened["ok"], true, "{opened}");
    assert_eq!(opened["data"]["loaded"], true, "{opened}");
    assert!(snapshot.contains("Name"));
    let id = opened["data"]["session_id"].as_str().unwrap();
    let other_port: u16 = std::env::var("OPENBITFUN_OTHER_BROWSER_TEST_PORT")
        .unwrap()
        .parse()
        .unwrap();
    let other_ctx = context("real-browser-other-workflow");
    let (other, _) = call(
        "connect",
        json!({"target":"external","mode":"headless","port":other_port,"activate":false}),
        &other_ctx,
    )
    .await;
    assert_eq!(other["ok"], true, "{other}");
    for action in ["list_pages", "tab_query", "list_sessions"] {
        let (inventory, _) = call(action, json!({}), &ctx).await;
        assert_eq!(inventory["ok"], true, "{inventory}");
        assert_eq!(inventory["data"]["default_session_id"], id, "{inventory}");
    }
    // A new conversation must not inherit another task's headless endpoint.
    let (unselected, text) = call(
        "list_pages",
        json!({"target":"external"}),
        &context("real-browser-unselected"),
    )
    .await;
    assert_eq!(unselected["error"]["code"], "NOT_AVAILABLE", "{unselected}");
    assert!(text.contains("Settings"));
    // New tabs inherit this conversation's connection, not the global default.
    let (new_tab, _) = call(
        "tab_new",
        json!({"url":"about:blank","activate":false}),
        &ctx,
    )
    .await;
    assert_eq!(new_tab["ok"], true, "{new_tab}");
    let new_id = new_tab["data"]["session_id"].as_str().unwrap();
    assert_eq!(
        browser_sessions().get(Some(new_id)).await.unwrap().port,
        port
    );
    let other_pages = CdpClient::list_pages(other_port).await.unwrap();
    assert!(!other_pages.iter().any(|page| page.id == new_id));
    call("close", json!({}), &ctx).await;
    // An exact known page carries its port even for an explicit connect call.
    let (reselected, _) = call("connect", json!({"session_id":id,"activate":false}), &ctx).await;
    assert_eq!(reselected["ok"], true, "{reselected}");
    assert_eq!(reselected["data"]["port"], port);
    let elements = opened["data"]["observation"]["elements"]
        .as_array()
        .unwrap();
    let input = elements.iter().find(|e| e["id"] == "name").unwrap()["ref"]
        .as_str()
        .unwrap();
    let button = elements.iter().find(|e| e["id"] == "apply").unwrap()["ref"]
        .as_str()
        .unwrap();
    assert_eq!(
        call(
            "fill",
            json!({"selector":input,"value":"Browser fixture"}),
            &ctx
        )
        .await
        .0["ok"],
        true
    );
    let (clicked, _) = call("click", json!({"selector":button}), &ctx).await;
    assert_eq!(clicked["ok"], true, "{clicked}");
    let (article, text) = call("read_article", json!({}), &ctx).await;
    assert_eq!(article["data"]["session_id"], id);
    assert!(text.contains("Saved: Browser fixture"));
    assert!(text.contains("BODY_AFTER_EXCERPT"));
    let (_, text) = call("fetch", json!({"url":format!("{url}api")}), &ctx).await;
    assert!(text.contains("200") && text.contains("fixture-response"));
    let (wait, _) = call("wait", json!({"condition":"load","timeout_ms":100}), &ctx).await;
    assert_eq!(wait["ok"], true);
    assert_eq!(wait["data"]["already_satisfied"], true);
    let (fragment, _) = call("navigate", json!({"url":format!("{url}#section")}), &ctx).await;
    assert_eq!(fragment["data"]["same_document"], true, "{fragment}");
    // This legacy URL-bearing shape still returns article at the original key.
    let (legacy, text) = call(
        "read_article",
        json!({"url":format!("{url}?legacy=1")}),
        &ctx,
    )
    .await;
    assert!(legacy["data"]["article"]["textContent"].is_string());
    assert!(text.contains("BODY_AFTER_EXCERPT"));

    let session = browser_sessions().get(Some(id)).await.unwrap();
    let actions = BrowserActions::new(session.client.as_ref());
    let before = actions
        .evaluate("({width:innerWidth,height:innerHeight})")
        .await
        .unwrap();
    let screenshot = actions
        .screenshot_with_options_ext("png", None, true, true)
        .await
        .unwrap();
    use base64::Engine as _;
    let png = base64::engine::general_purpose::STANDARD
        .decode(screenshot["base64_data"].as_str().unwrap())
        .unwrap();
    assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
    let height = u32::from_be_bytes(png[20..24].try_into().unwrap());
    assert!(u64::from(height) > before["result"]["value"]["height"].as_u64().unwrap());
    let after = actions
        .evaluate("({width:innerWidth,height:innerHeight})")
        .await
        .unwrap();
    assert_eq!(before["result"]["value"], after["result"]["value"]);
    let (closed, _) = call("close", json!({}), &ctx).await;
    assert_eq!(closed["ok"], true);
    let (stale, _) = call("get_url", json!({}), &ctx).await;
    assert_eq!(stale["error"]["code"], "WRONG_TAB");
    release_browser_selection("real-browser-workflow").await;
    release_browser_selection("real-browser-other-workflow").await;
}
