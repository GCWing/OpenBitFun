use super::*;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use openbitfun_product_domains::html_preview::PREVIEW_CHUNK_BYTES;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};

struct Reader {
    bytes: Vec<u8>,
    requests: Mutex<Vec<HtmlPreviewResourceRequest>>,
    unavailable: AtomicBool,
    blocked: AtomicBool,
    reading: tokio::sync::Notify,
    unblock: tokio::sync::Notify,
}

#[async_trait::async_trait]
impl PreviewReader for Reader {
    async fn read(
        &self,
        request: &HtmlPreviewResourceRequest,
    ) -> Result<HtmlPreviewResource, HtmlPreviewError> {
        self.requests.lock().unwrap().push(request.clone());
        if self.blocked.load(Ordering::SeqCst) {
            self.reading.notify_one();
            self.unblock.notified().await;
        }
        if self.unavailable.load(Ordering::SeqCst) {
            return Err(HtmlPreviewError::unavailable("Peer is offline"));
        }
        if request.resource_path.as_deref() == Some("missing.js") {
            return Err(HtmlPreviewError::new(Code::NotFound, "Missing resource"));
        }
        let count = if request.metadata_only {
            0
        } else {
            (self.bytes.len() - request.offset as usize).min(PREVIEW_CHUNK_BYTES)
        };
        Ok(HtmlPreviewResource {
            entry_path: "site/dist/index #1.html".into(),
            resource_path: request
                .resource_path
                .clone()
                .unwrap_or_else(|| "site/dist/index #1.html".into()),
            source: "workspace-provider".into(),
            revision: "revision-1".into(),
            mime_type: "text/html; charset=utf-8".into(),
            size: self.bytes.len() as u64,
            offset: request.offset,
            content_base64: BASE64
                .encode(&self.bytes[request.offset as usize..request.offset as usize + count]),
        })
    }
}

fn resource_request() -> HtmlPreviewResourceRequest {
    HtmlPreviewResourceRequest {
        workspace_id: "workspace".into(),
        file_path: "/repo/site/dist/index #1.html".into(),
        resource_path: None,
        metadata_only: true,
        offset: 0,
        expected_source: None,
        expected_revision: None,
    }
}

async fn fixture(bytes: Vec<u8>) -> (HtmlPreviewCreateResponse, Arc<Reader>, reqwest::Client) {
    crate::ensure_rustls_crypto_provider();
    let reader = Arc::new(Reader {
        bytes,
        requests: Mutex::new(vec![]),
        unavailable: AtomicBool::new(false),
        blocked: AtomicBool::new(false),
        reading: Default::default(),
        unblock: Default::default(),
    });
    let preview = start_preview(reader.clone(), resource_request())
        .await
        .unwrap();
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    (preview, reader, client)
}

async fn bootstrap(
    client: &reqwest::Client,
    preview: &HtmlPreviewCreateResponse,
) -> (String, String) {
    let reply = client.get(&preview.url).send().await.unwrap();
    assert_eq!(reply.status(), StatusCode::FOUND);
    let cookie = reply.headers()[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string();
    let location = reply.headers()[header::LOCATION].to_str().unwrap();
    assert_eq!(location, "/site/dist/index%20%231.html");
    let entry = reqwest::Url::parse(&preview.url)
        .unwrap()
        .join(location)
        .unwrap()
        .to_string();
    (cookie, entry)
}

async fn release(preview: HtmlPreviewCreateResponse) {
    html_preview_release(HtmlPreviewReleaseRequest {
        session_id: preview.session_id,
    })
    .await
    .unwrap();
}

async fn site_fixture(
    filename: &str,
) -> (
    tempfile::TempDir,
    HtmlPreviewCreateResponse,
    reqwest::Client,
) {
    use openbitfun_services_integrations::remote_connect::{
        file_projection::SessionFileTarget, html_preview::HtmlPreviewSource,
    };
    crate::ensure_rustls_crypto_provider();
    let directory = tempfile::tempdir().unwrap();
    let site = directory.path().join("website/dist");
    std::fs::create_dir_all(site.join("assets")).unwrap();
    std::fs::create_dir_all(site.join("guide")).unwrap();
    std::fs::write(site.join(filename), b"<main>site entry</main>").unwrap();
    std::fs::write(site.join("assets/image.png"), [137, 80, 78, 71]).unwrap();
    std::fs::write(site.join("assets/app.js"), b"window.siteLoaded=true").unwrap();
    std::fs::write(site.join("guide/index.html"), b"<main>static guide</main>").unwrap();
    let mut request = resource_request();
    request.file_path = site.join(filename).to_string_lossy().into_owned();
    let reader = HtmlPreviewSource::new(
        SessionFileTarget {
            fs: Arc::new(openbitfun_services_core::workspace::LocalWorkspaceFs),
            root: directory.path().to_string_lossy().into_owned(),
            path: request.file_path.clone(),
            remote: false,
        },
        "site-workspace",
    )
    .await
    .unwrap();
    let preview = start_preview(Arc::new(reader), request).await.unwrap();
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    (directory, preview, client)
}

#[tokio::test]
async fn site_index_opens_at_root_and_document_routes_reuse_the_entry() {
    for filename in ["index.html", "index.htm"] {
        let (_directory, preview, client) = site_fixture(filename).await;
        let reply = client.get(&preview.url).send().await.unwrap();
        assert_eq!(reply.headers()[header::LOCATION], "/");
        let cookie = reply.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap();
        let origin = reqwest::Url::parse(&preview.url)
            .unwrap()
            .join("/")
            .unwrap();
        for route in [
            "/",
            "/evaluation?tab=results",
            "/zh/evaluation/snapshots/example",
            "/docs/",
        ] {
            let reply = client
                .get(origin.join(route).unwrap())
                .header(header::COOKIE, cookie)
                .header(header::ACCEPT, "text/html,application/xhtml+xml,*/*;q=0.8")
                .header("sec-fetch-dest", "document")
                .send()
                .await
                .unwrap();
            assert_eq!(reply.status(), StatusCode::OK, "{filename}: {route}");
            assert_eq!(reply.text().await.unwrap(), "<main>site entry</main>");
        }
        let reply = client
            .head(origin.join("/evaluation").unwrap())
            .header(header::COOKIE, cookie)
            .header(header::ACCEPT, "text/html")
            .send()
            .await
            .unwrap();
        assert_eq!(reply.status(), StatusCode::OK);
        assert_eq!(reply.headers()[header::CONTENT_LENGTH], "23");
        assert!(reply.bytes().await.unwrap().is_empty());
        let reply = client
            .get(origin.join("/guide/").unwrap())
            .header(header::COOKIE, cookie)
            .header(header::ACCEPT, "text/html")
            .send()
            .await
            .unwrap();
        assert_eq!(reply.text().await.unwrap(), "<main>static guide</main>");
        for alias in [format!("/{filename}"), format!("/website/dist/{filename}")] {
            let reply = client
                .get(origin.join(&format!("{alias}?lang=en")).unwrap())
                .header(header::COOKIE, cookie)
                .send()
                .await
                .unwrap();
            assert_eq!(reply.status(), StatusCode::FOUND);
            assert_eq!(reply.headers()[header::LOCATION], "/?lang=en");
        }
        release(preview).await;
    }
}

#[tokio::test]
async fn site_routes_never_replace_missing_assets_or_bypass_path_authorization() {
    let (_directory, preview, client) = site_fixture("index.html").await;
    let reply = client.get(&preview.url).send().await.unwrap();
    let cookie = reply.headers()[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap();
    let origin = reqwest::Url::parse(&preview.url)
        .unwrap()
        .join("/")
        .unwrap();
    for (path, accept, destination) in [
        ("/assets/missing.png", "text/html", "document"),
        ("/assets/missing.js", "text/html", "document"),
        ("/missing.html", "text/html", "document"),
        ("/missing", "application/json", "empty"),
        ("/missing", "*/*", "empty"),
        ("/missing", "text/html;q=0,*/*", "document"),
        ("/missing", "text/html", "image"),
        ("/missing", "text/html", "script"),
    ] {
        let reply = client
            .get(origin.join(path).unwrap())
            .header(header::COOKIE, cookie)
            .header(header::ACCEPT, accept)
            .header("sec-fetch-dest", destination)
            .send()
            .await
            .unwrap();
        assert_eq!(
            reply.status(),
            StatusCode::NOT_FOUND,
            "{path}: {accept}, {destination}"
        );
    }
    let reply = client
        .get(origin.join("/evaluation").unwrap())
        .header(header::ACCEPT, "text/html")
        .send()
        .await
        .unwrap();
    assert_eq!(reply.status(), StatusCode::NOT_FOUND);
    let reply = client
        .get(origin.join("/%2e%2e%2Fprivate").unwrap())
        .header(header::COOKIE, cookie)
        .header(header::ACCEPT, "text/html")
        .send()
        .await
        .unwrap();
    assert_eq!(reply.status(), StatusCode::BAD_REQUEST);
    let reply = client
        .get(origin.join("/assets/image.png").unwrap())
        .header(header::COOKIE, cookie)
        .header(header::ACCEPT, "image/*")
        .send()
        .await
        .unwrap();
    assert_eq!(reply.headers()[header::CONTENT_TYPE], "image/png");
    assert_eq!(reply.bytes().await.unwrap().as_ref(), &[137, 80, 78, 71]);
    release(preview).await;
}

#[tokio::test]
async fn standalone_html_keeps_its_directory_and_does_not_gain_site_route_fallback() {
    let (_directory, preview, client) = site_fixture("report #1.html").await;
    let reply = client.get(&preview.url).send().await.unwrap();
    assert_eq!(
        reply.headers()[header::LOCATION],
        "/website/dist/report%20%231.html"
    );
    let cookie = reply.headers()[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap();
    let reply = client
        .get(
            reqwest::Url::parse(&preview.url)
                .unwrap()
                .join("/evaluation")
                .unwrap(),
        )
        .header(header::COOKIE, cookie)
        .header(header::ACCEPT, "text/html")
        .send()
        .await
        .unwrap();
    assert_eq!(reply.status(), StatusCode::NOT_FOUND);
    release(preview).await;
}

#[tokio::test]
async fn site_document_routes_preserve_owner_errors_instead_of_reading_the_entry() {
    struct FailingSiteReader {
        error: Code,
        entry_reads: std::sync::atomic::AtomicUsize,
    }
    #[async_trait::async_trait]
    impl PreviewReader for FailingSiteReader {
        async fn read(
            &self,
            request: &HtmlPreviewResourceRequest,
        ) -> Result<HtmlPreviewResource, HtmlPreviewError> {
            if request.resource_path.is_some() {
                return Err(HtmlPreviewError::new(
                    self.error,
                    "Owner rejected the resource",
                ));
            }
            self.entry_reads.fetch_add(1, Ordering::SeqCst);
            Ok(HtmlPreviewResource {
                entry_path: "website/dist/index.html".into(),
                resource_path: "website/dist/index.html".into(),
                source: "owner".into(),
                revision: "revision".into(),
                mime_type: "text/html; charset=utf-8".into(),
                size: 0,
                offset: 0,
                content_base64: String::new(),
            })
        }
    }
    crate::ensure_rustls_crypto_provider();
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    for (error, status) in [
        (Code::Forbidden, StatusCode::FORBIDDEN),
        (Code::Unavailable, StatusCode::BAD_GATEWAY),
        (Code::Changed, StatusCode::CONFLICT),
        (Code::InvalidPath, StatusCode::BAD_REQUEST),
        (Code::TooLarge, StatusCode::PAYLOAD_TOO_LARGE),
    ] {
        let reader = Arc::new(FailingSiteReader {
            error,
            entry_reads: Default::default(),
        });
        let preview = start_preview(reader.clone(), resource_request())
            .await
            .unwrap();
        let reply = client.get(&preview.url).send().await.unwrap();
        let cookie = reply.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap();
        let reply = client
            .get(
                reqwest::Url::parse(&preview.url)
                    .unwrap()
                    .join("/evaluation")
                    .unwrap(),
            )
            .header(header::COOKIE, cookie)
            .header(header::ACCEPT, "text/html")
            .send()
            .await
            .unwrap();
        assert_eq!(reply.status(), status);
        assert_eq!(
            reader.entry_reads.load(Ordering::SeqCst),
            1,
            "Only bootstrap may read the entry"
        );
        release(preview).await;
    }
}

#[tokio::test]
async fn http_bootstrap_streams_bounded_chunks_and_preserves_head() {
    let bytes = vec![71; PREVIEW_CHUNK_BYTES * 2 + 11];
    let (preview, reader, client) = fixture(bytes.clone()).await;
    let (cookie, entry) = bootstrap(&client, &preview).await;
    assert_eq!(
        client.get(&entry).send().await.unwrap().status(),
        StatusCode::NOT_FOUND
    );
    let reply = client
        .get(&entry)
        .header(header::COOKIE, &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(reply.status(), StatusCode::OK);
    assert_eq!(
        reply.headers()[header::CONTENT_LENGTH],
        bytes.len().to_string()
    );
    assert_eq!(reply.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
    assert_eq!(reply.bytes().await.unwrap().as_ref(), &bytes);
    let requests = reader.requests.lock().unwrap().clone();
    assert_eq!(
        requests.len(),
        4,
        "bootstrap metadata plus three bounded content reads"
    );
    assert_eq!(
        requests[1].resource_path.as_deref(),
        Some("site/dist/index #1.html")
    );
    assert_eq!(requests[2].offset, PREVIEW_CHUNK_BYTES as u64);
    assert_eq!(requests[3].expected_revision.as_deref(), Some("revision-1"));
    assert_eq!(
        requests[3].expected_source.as_deref(),
        Some("workspace-provider")
    );
    let reply = client
        .head(&entry)
        .header(header::COOKIE, &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(
        reply.headers()[header::CONTENT_LENGTH],
        bytes.len().to_string()
    );
    assert!(reply.bytes().await.unwrap().is_empty());
    assert!(
        reader
            .requests
            .lock()
            .unwrap()
            .last()
            .unwrap()
            .metadata_only
    );
    assert_eq!(
        client
            .post(&entry)
            .header(header::COOKIE, &cookie)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    release(preview).await;
}

#[tokio::test]
async fn concurrent_preview_cookies_do_not_overwrite_or_authorize_each_other() {
    let (first, _, client) = fixture(b"first".to_vec()).await;
    let (second, _, _) = fixture(b"second".to_vec()).await;
    let (first_cookie, first_url) = bootstrap(&client, &first).await;
    let (second_cookie, second_url) = bootstrap(&client, &second).await;
    assert_ne!(
        first_cookie.split('=').next(),
        second_cookie.split('=').next()
    );
    assert_eq!(
        client
            .get(&first_url)
            .header(header::COOKIE, &second_cookie)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    // Browsers share cookies across ports on 127.0.0.1; both cookies will be sent.
    let cookies = format!("{first_cookie}; {second_cookie}");
    assert_eq!(
        client
            .get(&first_url)
            .header(header::COOKIE, &cookies)
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
        "first"
    );
    assert_eq!(
        client
            .get(&second_url)
            .header(header::COOKIE, &cookies)
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
        "second"
    );
    release(first).await;
    release(second).await;
}

#[tokio::test]
async fn gateway_reports_missing_and_offline_resources_and_recovers_on_reload() {
    let (preview, reader, client) = fixture(b"remote-content".to_vec()).await;
    let (cookie, entry) = bootstrap(&client, &preview).await;
    let missing = reqwest::Url::parse(&entry)
        .unwrap()
        .join("/missing.js")
        .unwrap();
    assert_eq!(
        client
            .get(missing)
            .header(header::COOKIE, &cookie)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    reader.unavailable.store(true, Ordering::SeqCst);
    let reply = client
        .get(&entry)
        .header(header::COOKIE, &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(reply.status(), StatusCode::BAD_GATEWAY);
    assert!(reply.text().await.unwrap().contains("Peer is offline"));
    reader.unavailable.store(false, Ordering::SeqCst);
    assert_eq!(
        client
            .get(&entry)
            .header(header::COOKIE, &cookie)
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
        "remote-content"
    );
    release(preview).await;
}

#[tokio::test]
async fn closing_preview_cancels_in_flight_resource_read() {
    let (preview, reader, client) = fixture(b"remote-content".to_vec()).await;
    let (cookie, entry) = bootstrap(&client, &preview).await;
    reader.blocked.store(true, Ordering::SeqCst);
    let request = tokio::spawn(async move {
        client
            .get(entry)
            .header(header::COOKIE, cookie)
            .send()
            .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(2), reader.reading.notified())
        .await
        .unwrap();
    release(preview).await;
    let reply = tokio::time::timeout(std::time::Duration::from_secs(2), request)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(reply.status(), StatusCode::BAD_GATEWAY);
}

#[test]
fn current_and_legacy_preview_requests_round_trip_without_guessing_peer_identity() {
    for payload in [
        serde_json::json!({"workspaceId":"remote-id", "filePath":"/repo/index.html"}),
        serde_json::json!({"workspacePath":"/repo", "filePath":"/repo/index.html", "remoteConnectionId":"ssh-1"}),
        serde_json::json!({"workspaceId":"remote-id", "filePath":"/repo/index.html", "peerDeviceMode":true}),
    ] {
        let request: HtmlPreviewCreateRequest = serde_json::from_value(payload.clone()).unwrap();
        assert!(request.peer_device_id.is_none());
        let encoded = serde_json::to_value(request).unwrap();
        for (key, value) in payload.as_object().unwrap() {
            assert_eq!(&encoded[key], value);
        }
        let decoded: HtmlPreviewCreateRequest = serde_json::from_value(encoded).unwrap();
        assert_eq!(decoded.file_path, "/repo/index.html");
    }
}

#[test]
fn peer_capability_is_required_even_for_desktop_and_wire_failures_are_explicit() {
    for ping in [
        serde_json::json!({}),
        serde_json::json!({"host_type":"desktop","capabilities":{}}),
        serde_json::json!({"capabilities":{"workspace_html_preview_v1":false}}),
    ] {
        assert!(require_preview_capability(&ping)
            .unwrap_err()
            .message
            .contains("update OpenBitFun"));
    }
    for host in ["desktop", "cli"] {
        assert!(require_preview_capability(
            &serde_json::json!({"host_type":host,"capabilities":{"workspace_html_preview_v1":true}})
        )
        .is_ok());
    }
    assert!(
        decode_peer_result(r#"{"resp":"host_invoke_result","ok":false,"error":"offline"}"#)
            .is_err()
    );
    assert!(decode_peer_result(r#"{"resp":"error","message":"unsupported"}"#).is_err());
    assert!(decode_peer_result(r#"{"resp":"host_invoke_result","ok":true}"#).is_err());
    assert!(decode_peer_result("invalid").is_err());
}

// Called from the relay fixture while it owns the isolated account context.
pub(crate) async fn verify_encrypted_peer_gateway(
    device_id: &str,
    request: HtmlPreviewResourceRequest,
    expected: &[u8],
) {
    let reader = Arc::new(PeerPreviewReader {
        device_id: device_id.into(),
        account_generation: account_context_generation(),
    });
    reader.ensure_supported().await.unwrap();
    let preview = start_preview(reader, request).await.unwrap();
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let reply = client.get(&preview.url).send().await.unwrap();
    assert_eq!(reply.status(), StatusCode::FOUND);
    let cookie = reply.headers()[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap();
    let asset = reqwest::Url::parse(&preview.url)
        .unwrap()
        .join("/assets/large.js")
        .unwrap();
    let reply = client
        .get(asset)
        .header(header::COOKIE, cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(reply.status(), StatusCode::OK);
    assert_eq!(
        reply.headers()[header::CONTENT_TYPE],
        "text/javascript; charset=utf-8"
    );
    assert_eq!(reply.bytes().await.unwrap().as_ref(), expected);
    release(preview).await;
}

// Uses the existing v1 peer reader, including a target without any routing changes.
pub(crate) async fn verify_encrypted_peer_site_routes(
    device_id: &str,
    request: HtmlPreviewResourceRequest,
    expected_html: &[u8],
    expected_image: &[u8],
) {
    let reader = Arc::new(PeerPreviewReader {
        device_id: device_id.into(),
        account_generation: account_context_generation(),
    });
    reader.ensure_supported().await.unwrap();
    let preview = start_preview(reader, request).await.unwrap();
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let reply = client.get(&preview.url).send().await.unwrap();
    assert_eq!(reply.headers()[header::LOCATION], "/");
    let cookie = reply.headers()[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap();
    let origin = reqwest::Url::parse(&preview.url)
        .unwrap()
        .join("/")
        .unwrap();
    for route in ["/", "/evaluation", "/docs/detail?lang=en", "/evaluation"] {
        let reply = client
            .get(origin.join(route).unwrap())
            .header(header::COOKIE, cookie)
            .header(header::ACCEPT, "text/html")
            .header(header::CACHE_CONTROL, "no-cache")
            .send()
            .await
            .unwrap();
        assert_eq!(reply.status(), StatusCode::OK, "{route}");
        assert_eq!(reply.bytes().await.unwrap().as_ref(), expected_html);
    }
    let reply = client
        .get(origin.join("/assets/image.png").unwrap())
        .header(header::COOKIE, cookie)
        .header(header::ACCEPT, "image/png")
        .send()
        .await
        .unwrap();
    assert_eq!(reply.status(), StatusCode::OK);
    assert_eq!(reply.headers()[header::CONTENT_TYPE], "image/png");
    assert_eq!(reply.bytes().await.unwrap().as_ref(), expected_image);
    let reply = client
        .get(origin.join("/assets/missing.png").unwrap())
        .header(header::COOKIE, cookie)
        .header(header::ACCEPT, "image/png")
        .send()
        .await
        .unwrap();
    assert_eq!(reply.status(), StatusCode::NOT_FOUND);
    release(preview).await;
}

pub(crate) async fn benchmark_encrypted_peer_gateway(
    device_id: &str,
    mut input: HtmlPreviewResourceRequest,
    files: Vec<(String, Vec<u8>)>,
) {
    use futures::{stream, StreamExt};
    let reader = Arc::new(PeerPreviewReader {
        device_id: device_id.into(),
        account_generation: account_context_generation(),
    });
    reader.ensure_supported().await.unwrap();
    input.expected_source = Some(reader.read(&input).await.unwrap().source);
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let mut serial = Vec::new();
    let mut cold = Vec::new();
    let mut warm = Vec::new();
    for _ in 0..3 {
        let start = std::time::Instant::now();
        for group in [&files[..1], &files[1..]] {
            stream::iter(group.iter())
                .map(|(path, expected)| {
                    let reader = reader.clone();
                    let mut request = input.clone();
                    request.metadata_only = false;
                    request.resource_path = Some(path.clone());
                    async move {
                        let mut bytes = Vec::new();
                        loop {
                            let file = reader.read(&request).await.unwrap();
                            bytes.extend(BASE64.decode(file.content_base64).unwrap());
                            request.expected_revision = Some(file.revision);
                            request.offset = bytes.len() as u64;
                            if request.offset == file.size {
                                break;
                            }
                        }
                        assert_eq!(&bytes, expected);
                    }
                })
                .buffer_unordered(6)
                .collect::<Vec<_>>()
                .await;
        }
        serial.push(start.elapsed().as_millis());
        let preview = start_preview(reader.clone(), input.clone()).await.unwrap();
        let bootstrap = client.get(&preview.url).send().await.unwrap();
        let cookie = bootstrap.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap();
        let origin = reqwest::Url::parse(&preview.url).unwrap();
        for times in [&mut cold, &mut warm] {
            let start = std::time::Instant::now();
            for group in [&files[..1], &files[1..]] {
                stream::iter(group.iter())
                    .map(|(path, expected)| {
                        let client = client.clone();
                        let url = origin
                            .join(if path == &files[0].0 { "/" } else { path })
                            .unwrap();
                        async move {
                            let response = client
                                .get(url)
                                .header(header::COOKIE, cookie)
                                .send()
                                .await
                                .unwrap();
                            assert_eq!(response.status(), StatusCode::OK);
                            assert_eq!(response.bytes().await.unwrap().as_ref(), expected);
                        }
                    })
                    .buffer_unordered(6)
                    .collect::<Vec<_>>()
                    .await;
            }
            times.push(start.elapsed().as_millis());
        }
        release(preview).await;
    }
    println!("HTML_PREVIEW_BENCH transport=encrypted-peer-40ms bytes={} serial_ms={serial:?} cold_ms={cold:?} warm_ms={warm:?}", files.iter().map(|(_, bytes)| bytes.len()).sum::<usize>());
}

#[tokio::test]
async fn http_cache_revalidates_and_explicit_reload_bypasses_content_cache() {
    let (preview, reader, client) = fixture(vec![21; PREVIEW_CHUNK_BYTES + 3]).await;
    let (cookie, entry) = bootstrap(&client, &preview).await;
    for control in [
        None,
        None,
        Some("max-age=0"),
        Some("no-cache"),
        Some("no-store"),
    ] {
        let before = reader.requests.lock().unwrap().len();
        let mut request = client.get(&entry).header(header::COOKIE, &cookie);
        if let Some(control) = control {
            request = request.header(header::CACHE_CONTROL, control);
        }
        assert_eq!(
            request.send().await.unwrap().bytes().await.unwrap().len(),
            PREVIEW_CHUNK_BYTES + 3
        );
        let requests = reader.requests.lock().unwrap();
        if before > 1 && control.is_none() {
            assert_eq!(requests.len() - before, 1);
            assert!(requests.last().unwrap().metadata_only);
        } else {
            assert_eq!(requests.len() - before, 2);
            assert!(!requests.last().unwrap().metadata_only);
        }
    }
    reader.unavailable.store(true, Ordering::SeqCst);
    assert_eq!(
        client
            .get(&entry)
            .header(header::COOKIE, &cookie)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_GATEWAY
    );
    assert_eq!(
        client.get(&entry).send().await.unwrap().status(),
        StatusCode::NOT_FOUND
    );
    release(preview).await;
}

#[test]
fn reload_directives_handle_repeated_headers_and_case() {
    for (name, value) in [
        (header::CACHE_CONTROL, "No-Cache"),
        (header::CACHE_CONTROL, "max-age = \"0\""),
        (header::CACHE_CONTROL, "private, NO-STORE"),
        (header::PRAGMA, "no-cache"),
    ] {
        let mut headers = HeaderMap::new();
        headers.append(header::CACHE_CONTROL, "max-age=60".parse().unwrap());
        headers.append(name, value.parse().unwrap());
        assert!(force_resource_reload(&headers));
    }
    let mut headers = HeaderMap::new();
    headers.insert(header::CACHE_CONTROL, "max-age=60".parse().unwrap());
    assert!(!force_resource_reload(&headers));
}

#[tokio::test]
async fn http_cache_busting_queries_have_distinct_entries_without_changing_file_paths() {
    let (preview, reader, client) = fixture(vec![31; PREVIEW_CHUNK_BYTES + 7]).await;
    let (cookie, entry) = bootstrap(&client, &preview).await;
    for (query, content_reads) in [("v=1", 2), ("v=1", 1), ("v=2", 2), ("v=2", 1), ("v=1", 1)] {
        let before = reader.requests.lock().unwrap().len();
        let response = client
            .get(format!("{entry}?{query}"))
            .header(header::COOKIE, &cookie)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.bytes().await.unwrap().len(),
            PREVIEW_CHUNK_BYTES + 7
        );
        let requests = reader.requests.lock().unwrap();
        assert_eq!(requests.len() - before, content_reads, "{query}");
        assert!(requests[before..]
            .iter()
            .all(|request| request.resource_path.as_deref() == Some("site/dist/index #1.html")));
    }
    release(preview).await;
}
