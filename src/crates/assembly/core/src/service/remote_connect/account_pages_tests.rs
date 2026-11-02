//! Account-backed Pages adapter contracts against a local Relay fixture.
use super::*;
use crate::agentic::tools::page_manage_host::PageManageRequest;
use crate::agentic::tools::page_publish_host::PagePublishHostRequest;
use crate::product_runtime::account_pages::{account_availability, deploy, manage, publish};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn request() -> PagePublishHostRequest {
    PagePublishHostRequest {
        slug: "demo".into(),
        visibility: "public".into(),
        title: Some("Demo".into()),
        note: None,
        deploy: true,
        directory: None,
        files: Some(std::collections::HashMap::from([(
            "index.html".into(),
            "Hello".into(),
        )])),
    }
}

async fn logged_in(relay: String) -> Arc<AccountRuntime> {
    let runtime = super::tests::test_runtime();
    *runtime.account_context.write().await = Some(AccountContextState {
        session: AccountSession::new("test-pages-token".into(), "user-a".into(), [0; 32]),
        relay_url: relay,
    });
    runtime
}

fn page() -> Value {
    json!({"slug":"demo", "generation":"generation-a", "visibility":"public", "title":"Demo",
        "file_count":1, "total_bytes":5, "created_at":1, "updated_at":1,
        "url_path":"/p/demo", "deployed_version_id":"v1"})
}

async fn relay(
    responses: Vec<(&'static str, Value)>,
) -> (String, tokio::task::JoinHandle<Vec<Value>>) {
    relay_with_hook(responses, Arc::new(|_| {})).await
}

async fn relay_with_hook(
    responses: Vec<(&'static str, Value)>,
    hook: Arc<dyn Fn(usize) + Send + Sync>,
) -> (String, tokio::task::JoinHandle<Vec<Value>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let mut bodies = Vec::new();
        for (index, (expected, mut response)) in responses.into_iter().enumerate() {
            let (mut socket, _) = tokio::time::timeout(Duration::from_secs(10), listener.accept())
                .await
                .unwrap()
                .unwrap();
            let mut data = Vec::new();
            let header_end = loop {
                let mut chunk = [0; 4096];
                let n = socket.read(&mut chunk).await.unwrap();
                assert!(n > 0);
                data.extend_from_slice(&chunk[..n]);
                if let Some(i) = data.windows(4).position(|w| w == b"\r\n\r\n") {
                    break i + 4;
                }
            };
            let headers = String::from_utf8_lossy(&data[..header_end]);
            assert!(
                headers.starts_with(expected),
                "unexpected request: {}",
                headers.lines().next().unwrap()
            );
            assert!(headers
                .to_ascii_lowercase()
                .contains("authorization: bearer test-pages-token"));
            let length: usize = headers
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .map(|v| v.trim().parse().unwrap())
                })
                .unwrap_or(0);
            while data.len() < header_end + length {
                let mut chunk = [0; 4096];
                let n = socket.read(&mut chunk).await.unwrap();
                assert!(n > 0);
                data.extend_from_slice(&chunk[..n]);
            }
            bodies.push(if length == 0 {
                Value::Null
            } else {
                serde_json::from_slice(&data[header_end..header_end + length]).unwrap()
            });
            hook(index);
            if response["upload_id"] == "$request" {
                response["upload_id"] = bodies.last().unwrap()["upload_id"].clone();
            }
            let body = response.to_string();
            let wire = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
            socket.write_all(wire.as_bytes()).await.unwrap();
        }
        bodies
    });
    (url, task)
}

#[tokio::test]
async fn page_account_availability_tracks_identity_and_runtime_lifetime() {
    let runtime = logged_in("http://127.0.0.1:1".into()).await;
    let available = account_availability(&runtime);
    assert!(available().await);
    let transition = runtime.begin_account_transition().await;
    assert!(!available().await);
    transition.finish();
    assert!(available().await);
    runtime.mark_token_expired();
    assert!(!available().await);
    assert!(publish(&runtime, request())
        .await
        .unwrap_err()
        .contains("expired"));
    runtime.token_expired.store(false, Ordering::Relaxed);
    *runtime.account_context.write().await = None;
    assert!(!available().await);
    assert!(deploy(&runtime, "demo", "v1")
        .await
        .unwrap_err()
        .contains("not logged in"));
    drop(runtime);
    assert!(!available().await);
}

#[tokio::test]
async fn page_publish_uploads_inline_content_and_deploys_with_legacy_relay() {
    let (url, server) = relay(vec![
        ("GET /api/pages ", json!([])),
        (
            "POST /api/pages/check-files ",
            json!({"needed":["index.html"]}),
        ),
        ("POST /api/pages/upload-files ", json!({})),
        // Old relay payload omits generation; the existing compatibility path remains valid.
        (
            "POST /api/pages/demo/versions ",
            json!({"version_id":"v1", "title":"Demo", "file_count":1,
            "total_bytes":5, "has_worker":false, "note":"", "created_at":1, "deployed":false,
            "preview_url_path":"/preview/demo/v1"}),
        ),
        ("POST /api/pages/demo/deploy ", page()),
    ])
    .await;
    let runtime = logged_in(url.clone()).await;
    let result = publish(&runtime, request()).await.unwrap();
    assert_eq!(result["url"], format!("{url}/p/demo"));
    assert_eq!(result["preview_url"], format!("{url}/preview/demo/v1"));
    assert_eq!(result["deployed"], true);
    assert!(!result.to_string().contains("test-pages-token"));
    let bodies = server.await.unwrap();
    assert_eq!(bodies[1]["files"][0]["path"], "index.html");
    assert_eq!(bodies[2]["files"]["index.html"]["content"], "SGVsbG8=");
    assert_eq!(bodies[4]["version_id"], "v1");
}

#[tokio::test]
async fn page_deploy_uses_saved_generation_without_uploading() {
    let (url, server) = relay(vec![
        ("GET /api/pages ", json!([page()])),
        ("POST /api/pages/demo/deploy ", page()),
    ])
    .await;
    let runtime = logged_in(url.clone()).await;
    let result = deploy(&runtime, "demo", "v1").await.unwrap();
    assert_eq!(result["url"], format!("{url}/p/demo"));
    let bodies = server.await.unwrap();
    assert_eq!(bodies[1]["expected_generation"], "generation-a");
    assert_eq!(bodies[1]["version_id"], "v1");
}

#[tokio::test]
async fn page_deploy_stops_if_account_changes_during_lookup() {
    let runtime = logged_in("http://127.0.0.1:1".into()).await;
    let changed = runtime.clone();
    let (url, server) = relay_with_hook(
        vec![("GET /api/pages ", json!([page()]))],
        Arc::new(move |_| {
            changed
                .account_context_generation
                .fetch_add(1, Ordering::AcqRel);
        }),
    )
    .await;
    runtime
        .account_context
        .write()
        .await
        .as_mut()
        .unwrap()
        .relay_url = url;
    assert_eq!(
        deploy(&runtime, "demo", "v1").await.unwrap_err(),
        "account context changed"
    );
    assert_eq!(server.await.unwrap().len(), 1);
}

#[tokio::test]
async fn page_deploy_does_not_report_success_after_account_changes() {
    let runtime = logged_in("http://127.0.0.1:1".into()).await;
    let changed = runtime.clone();
    let (url, server) = relay_with_hook(
        vec![
            ("GET /api/pages ", json!([page()])),
            ("POST /api/pages/demo/deploy ", page()),
        ],
        Arc::new(move |index| {
            if index == 1 {
                changed
                    .account_context_generation
                    .fetch_add(1, Ordering::AcqRel);
            }
        }),
    )
    .await;
    runtime
        .account_context
        .write()
        .await
        .as_mut()
        .unwrap()
        .relay_url = url;
    assert!(deploy(&runtime, "demo", "v1")
        .await
        .unwrap_err()
        .contains("outcome is unknown"));
    server.await.unwrap();
}

fn manage_request(value: Value) -> PageManageRequest {
    serde_json::from_value(value).unwrap()
}

#[tokio::test]
async fn page_manage_publish_saves_a_private_preview_by_default() {
    let (url, server) = relay(vec![
        ("GET /api/pages ", json!([])),
        (
            "POST /api/pages/check-files ",
            json!({"needed":["index.html"]}),
        ),
        ("POST /api/pages/upload-files ", json!({})),
        (
            "POST /api/pages/demo/versions ",
            json!({"version_id":"v1", "title":"demo", "file_count":1,
            "total_bytes":5, "has_worker":false, "note":"", "created_at":1, "deployed":false,
            "preview_url_path":"/preview/demo/v1"}),
        ),
    ])
    .await;
    let runtime = logged_in(url.clone()).await;
    let result = manage(
        &runtime,
        manage_request(json!({"action":"publish", "slug":"demo", "files":{"index.html":"Hello"}})),
    )
    .await
    .unwrap();
    assert_eq!(result["action"], "publish");
    assert_eq!(result["deployed"], false);
    assert_eq!(result["visibility"], "private");
    assert_eq!(result["preview_url"], format!("{url}/preview/demo/v1"));
    let bodies = server.await.unwrap();
    assert_eq!(bodies.len(), 4);
    assert_eq!(bodies[2]["visibility"], "private");
}

#[tokio::test]
async fn page_manage_rejects_an_unreadable_catalog_instead_of_inventing_empty_results() {
    let (url, server) = relay(vec![("GET /api/pages ", json!({"error":"unavailable"}))]).await;
    let runtime = logged_in(url).await;
    assert!(manage(&runtime, manage_request(json!({"action":"list"})))
        .await
        .is_err());
    server.await.unwrap();
}

#[tokio::test]
async fn page_manage_list_returns_published_metadata_and_preserves_legacy_payloads() {
    let mut private = page();
    private["slug"] = json!("private-demo");
    private["visibility"] = json!("private");
    private["updated_at"] = json!(10);
    let mut unpublished = page();
    unpublished["slug"] = json!("draft");
    unpublished["deployed_version_id"] = Value::Null;
    unpublished["updated_at"] = json!(20);
    unpublished.as_object_mut().unwrap().remove("generation");
    let all = json!([page(), private, unpublished]);
    let (url, server) = relay(vec![
        ("GET /api/pages ", all.clone()),
        ("GET /api/pages ", all),
    ])
    .await;
    let runtime = logged_in(url.clone()).await;
    let result = manage(&runtime, manage_request(json!({"action":"list"})))
        .await
        .unwrap();
    assert_eq!(result["pages"].as_array().unwrap().len(), 2);
    assert_eq!(result["pages"][0]["slug"], "private-demo");
    assert_eq!(result["pages"][0]["name"], "Demo");
    assert_eq!(result["pages"][0]["visibility"], "private");
    assert_eq!(result["pages"][0]["updated_at"], 10);
    assert_eq!(result["pages"][0]["url"], format!("{url}/p/demo"));
    assert!(!result.to_string().contains("test-pages-token"));
    let result = manage(
        &runtime,
        manage_request(json!({"action":"list", "published_only":false})),
    )
    .await
    .unwrap();
    assert_eq!(result["pages"].as_array().unwrap().len(), 3);
    assert_eq!(result["pages"][0]["slug"], "draft");
    assert_eq!(result["pages"][0]["generation"], "");
    assert_eq!(result["pages"][0]["published"], false);
    let legacy: openbitfun_services_integrations::remote_connect::PageInfo =
        serde_json::from_value(result["pages"][0].clone()).unwrap();
    let round_trip = serde_json::to_value(legacy).unwrap();
    assert_eq!(round_trip["title"], "Demo");
    assert_eq!(round_trip["visibility"], "public");
    server.await.unwrap();
}

#[tokio::test]
async fn page_manage_routes_metadata_permissions_and_delete_with_generation() {
    for (input, method, expected_body) in [
        (
            json!({"action":"update", "slug":"demo", "title":"New name"}),
            "PATCH /api/pages/demo ",
            json!({"expected_generation":"generation-a", "title":"New name"}),
        ),
        (
            json!({"action":"permissions", "slug":"demo", "visibility":"private"}),
            "PATCH /api/pages/demo ",
            json!({"expected_generation":"generation-a", "visibility":"private"}),
        ),
        (
            json!({"action":"delete", "slug":"demo"}),
            "DELETE /api/pages/demo?expected_generation=generation-a ",
            Value::Null,
        ),
        (
            json!({"action":"delete", "slug":"demo", "version_id":"v1"}),
            "DELETE /api/pages/demo/versions/v1?expected_generation=generation-a ",
            Value::Null,
        ),
        (
            json!({"action":"unpublish", "slug":"demo"}),
            "POST /api/pages/demo/unpublish?expected_generation=generation-a ",
            Value::Null,
        ),
        (
            json!({"action":"deploy", "slug":"demo", "version_id":"v1"}),
            "POST /api/pages/demo/deploy ",
            json!({"expected_generation":"generation-a", "version_id":"v1"}),
        ),
    ] {
        let (url, server) =
            relay(vec![("GET /api/pages ", json!([page()])), (method, page())]).await;
        let runtime = logged_in(url).await;
        let result = manage(&runtime, manage_request(input.clone()))
            .await
            .unwrap();
        assert_eq!(result["action"], input["action"]);
        assert_eq!(result["slug"], "demo");
        if input["action"] == "delete" {
            assert_eq!(result["deleted"], true);
        }
        if input["action"] == "unpublish" {
            assert_eq!(result["unpublished"], true);
        }
        if input["action"] == "deploy" {
            assert_eq!(result["deployed"], true);
        }
        let bodies = server.await.unwrap();
        assert_eq!(bodies[1], expected_body);
    }
}

#[tokio::test]
async fn page_manage_content_update_keeps_name_visibility_and_inspected_generation() {
    for title in [None, Some("New title")] {
        let mut existing = page();
        existing["title"] = json!("Existing title");
        existing["visibility"] = json!("relay");
        let (url, server) = relay(vec![
        ("GET /api/pages ", json!([existing])),
        (
            "POST /api/pages/check-files ",
            json!({"needed":["index.html"], "upload_id":"$request", "expected_generation":"generation-a", "create":false, "metadata_preconditions_supported":true}),
        ),
        ("POST /api/pages/upload-files ", json!({})),
        (
            "POST /api/pages/demo/versions ",
            json!({"version_id":"v2", "title":"Existing title", "file_count":1,
            "total_bytes":5, "has_worker":false, "note":"", "created_at":2, "deployed":false,
            "preview_url_path":"/preview/demo/v2"}),
        ),
    ])
    .await;
        let runtime = logged_in(url.clone()).await;
        let result = manage(
        &runtime,
        manage_request(json!({"action":"update", "slug":"demo", "title":title, "files":{"index.html":"Hello"}})),
    )
    .await
    .unwrap();
        assert_eq!(result["action"], "update");
        assert_eq!(result["title"], title.unwrap_or("Existing title"));
        assert_eq!(result["visibility"], "relay");
        assert_eq!(result["deployed"], false);
        assert_eq!(result["preview_url"], format!("{url}/preview/demo/v2"));
        let bodies = server.await.unwrap();
        assert_eq!(bodies[1]["expected_generation"], "generation-a");
        assert_eq!(bodies[1]["create"], false);
        assert_eq!(bodies[2]["visibility"], "relay");
        assert_eq!(bodies[2]["title"], title.unwrap_or("Existing title"));
        assert_eq!(bodies[3]["expected_visibility"], "relay");
        assert_eq!(
            bodies[3]["expected_title"],
            if title.is_none() {
                json!("Existing title")
            } else {
                Value::Null
            }
        );
    }
}

#[tokio::test]
async fn page_manage_content_update_refuses_unnegotiated_metadata_protection() {
    for check in [
        json!({"needed":["index.html"]}),
        json!({"needed":["index.html"], "upload_id":"$request",
            "expected_generation":"generation-a", "create":false}),
        json!({"needed":["index.html"], "metadata_preconditions_supported":true}),
    ] {
        let (url, server) = relay(vec![
            ("GET /api/pages ", json!([page()])),
            ("POST /api/pages/check-files ", check),
        ])
        .await;
        let runtime = logged_in(url).await;
        let error = manage(
            &runtime,
            manage_request(json!({
                "action":"update", "slug":"demo", "files":{"index.html":"Hello"},
            })),
        )
        .await
        .unwrap_err();
        assert!(error.contains("does not support safe Page content updates"));
        // Neither an upload nor a freeze was issued to the older Relay.
        assert_eq!(server.await.unwrap().len(), 2);
    }
}

#[tokio::test]
async fn page_manage_versions_has_absolute_previews_and_accepts_old_relay_payloads() {
    let (url, server) = relay(vec![
        ("GET /api/pages ", json!([page()])),
        (
            "GET /api/pages/demo/versions?expected_generation=generation-a ",
            json!([{
                "version_id":"v1", "title":"Demo", "file_count":1, "total_bytes":5,
                "has_worker":false, "note":"First", "created_at":1, "deployed":true,
                "preview_url_path":"/preview/demo/v1"
            }]),
        ),
    ])
    .await;
    let runtime = logged_in(url.clone()).await;
    let result = manage(
        &runtime,
        manage_request(json!({"action":"versions", "slug":"demo"})),
    )
    .await
    .unwrap();
    assert_eq!(
        result["versions"][0]["preview_url"],
        format!("{url}/preview/demo/v1")
    );
    assert_eq!(result["versions"][0]["generation"], "");
    server.await.unwrap();
}

#[tokio::test]
async fn page_manage_missing_page_and_account_switch_never_continue_mutations() {
    let (url, server) = relay(vec![("GET /api/pages ", json!([]))]).await;
    let runtime = logged_in(url).await;
    assert!(manage(
        &runtime,
        manage_request(json!({"action":"update", "slug":"demo", "files":{"index.html":"New"}}))
    )
    .await
    .unwrap_err()
    .contains("Page not found"));
    server.await.unwrap();
    let changed = runtime.clone();
    let (url, server) = relay_with_hook(
        vec![("GET /api/pages ", json!([page()]))],
        Arc::new(move |_| {
            changed
                .account_context_generation
                .fetch_add(1, Ordering::AcqRel);
        }),
    )
    .await;
    runtime
        .account_context
        .write()
        .await
        .as_mut()
        .unwrap()
        .relay_url = url;
    assert_eq!(
        manage(
            &runtime,
            manage_request(json!({"action":"delete", "slug":"demo"}))
        )
        .await
        .unwrap_err(),
        "account context changed"
    );
    server.await.unwrap();
}

#[tokio::test]
async fn page_manage_does_not_report_success_after_account_switch_during_mutation() {
    let runtime = logged_in("http://127.0.0.1:1".into()).await;
    let changed = runtime.clone();
    let (url, server) = relay_with_hook(
        vec![
            ("GET /api/pages ", json!([page()])),
            ("PATCH /api/pages/demo ", page()),
        ],
        Arc::new(move |index| {
            if index == 1 {
                changed
                    .account_context_generation
                    .fetch_add(1, Ordering::AcqRel);
            }
        }),
    )
    .await;
    runtime
        .account_context
        .write()
        .await
        .as_mut()
        .unwrap()
        .relay_url = url;
    assert!(manage(
        &runtime,
        manage_request(json!({"action":"permissions", "slug":"demo", "visibility":"private"}))
    )
    .await
    .unwrap_err()
    .contains("outcome is unknown"));
    server.await.unwrap();
}
