//! End-to-end shared-router contract at the local and public path layouts.
use crate::{build_relay_router, db, identity::IdentityVerifier, MemoryAssetStore};
use axum::{
    body::{to_bytes, Body},
    http::{header, HeaderMap, Request, StatusCode},
    Extension, Json, Router,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio_tungstenite::tungstenite::Message;
use tower::ServiceExt;

async fn request(
    app: &Router,
    method: &str,
    path: &str,
    token: &str,
    body: Value,
) -> axum::response::Response {
    app.clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap()
}
async fn json_body(response: axum::response::Response) -> Value {
    serde_json::from_slice(&to_bytes(response.into_body(), 1_000_000).await.unwrap()).unwrap()
}

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn packet(socket: &mut Socket) -> String {
    loop {
        let message = tokio::time::timeout(Duration::from_secs(6), socket.next())
            .await
            .expect("realtime packet deadline")
            .expect("socket open")
            .expect("valid frame");
        match message {
            Message::Text(text) if text == "2" => {
                socket.send(Message::Text("3".into())).await.unwrap()
            }
            Message::Text(text) => return text.to_string(),
            Message::Ping(bytes) => socket.send(Message::Pong(bytes)).await.unwrap(),
            other => panic!("unexpected realtime frame: {other:?}"),
        }
    }
}

async fn connect_scope(
    address: std::net::SocketAddr,
    prefix: &str,
    token: &str,
    scope: &str,
) -> Socket {
    connect_scope_with_build(address, prefix, token, scope, None).await
}

async fn connect_scope_with_build(
    address: std::net::SocketAddr,
    prefix: &str,
    token: &str,
    scope: &str,
    build: Option<(&str, u32)>,
) -> Socket {
    let (mut socket, _) = tokio_tungstenite::connect_async(format!(
        "ws://{address}{prefix}/v1/updates/?EIO=4&transport=websocket"
    ))
    .await
    .unwrap();
    assert!(packet(&mut socket).await.starts_with('0'));
    let mut handshake = json!({"token":token,"clientType":scope});
    if let Some((version, protocol)) = build {
        handshake["clientVersion"] = json!(version);
        handshake["clientProtocol"] = json!(protocol);
    }
    socket
        .send(Message::Text(format!("40{handshake}").into()))
        .await
        .unwrap();
    assert!(packet(&mut socket).await.starts_with("40"));
    loop {
        let ready = packet(&mut socket).await;
        if let Some(event) = ready.strip_prefix("42") {
            let data: Value = serde_json::from_str(event).unwrap();
            if data[0] == "auth-ok" {
                break;
            }
        }
    }
    socket
}

/// Drain a socket for `window`, returning `false` if a forwarded `rpc-request`
/// arrived. Engine.IO pings are answered so the connection stays healthy.
async fn forwarded_no_rpc_request(socket: &mut Socket, window: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + window;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return true;
        }
        match tokio::time::timeout(remaining, socket.next()).await {
            Err(_) | Ok(None) | Ok(Some(Err(_))) => return true,
            Ok(Some(Ok(Message::Text(text)))) => {
                if text == "2" {
                    let _ = socket.send(Message::Text("3".into())).await;
                } else if text
                    .strip_prefix("42")
                    .is_some_and(|rest| rest.contains("rpc-request"))
                {
                    return false;
                }
            }
            Ok(Some(Ok(Message::Ping(bytes)))) => {
                let _ = socket.send(Message::Pong(bytes)).await;
            }
            Ok(Some(Ok(_))) => {}
        }
    }
}

async fn event(socket: &mut Socket, id: u32, name: &str, value: Value) {
    socket
        .send(Message::Text(
            format!("42{id}{}", json!([name, value])).into(),
        ))
        .await
        .unwrap();
}

async fn acknowledgement(socket: &mut Socket, id: u32) -> Value {
    let prefix = format!("43{id}[");
    loop {
        let value = packet(socket).await;
        if value.starts_with(&prefix) {
            let array: Value = serde_json::from_str(&value[prefix.len() - 1..]).unwrap();
            return array[0].clone();
        }
    }
}

#[tokio::test]
async fn official_and_local_layouts_share_authenticated_directory_and_rpc() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let authority_url = format!("http://{}/me", listener.local_addr().unwrap());
    let authority = Router::new().route(
        "/me",
        axum::routing::get(|headers: HeaderMap| async move {
            let (id, account_id) = match headers
                .get(header::AUTHORIZATION)
                .and_then(|value| value.to_str().ok())
            {
                Some("Bearer account-a") => (123, None),
                Some("Bearer account-b") => (456, None),
                Some("Bearer email-a") => (0, Some("email-123")),
                Some("Bearer email-b") => (0, Some("email-456")),
                _ => return (StatusCode::UNAUTHORIZED, Json(json!({}))),
            };
            (
                StatusCode::OK,
                Json(json!({"user":{"githubId":id,"accountId":account_id,"login":format!("user-{}", account_id.map(str::to_owned).unwrap_or_else(|| id.to_string()))}})),
            )
        }),
    );
    let authority_task = tokio::spawn(async move {
        axum::serve(listener, authority).await.unwrap();
    });
    for email in [false, true] {
        for prefix in ["", "/v/1.0.2"] {
            let db = Arc::new(db::connect(":memory:").await.unwrap());
            let shared = build_relay_router(
                Arc::new(MemoryAssetStore::new()),
                Instant::now(),
                db,
                "test",
            )
            .layer(Extension(
                IdentityVerifier::with_url(&authority_url).unwrap(),
            ));
            let app = if prefix.is_empty() {
                shared
            } else {
                Router::new().nest(prefix, shared)
            };
            let route = |path: &str| format!("{prefix}{path}");
            assert_eq!(
                request(&app, "GET", &route("/api/devices"), "", json!(null))
                    .await
                    .status(),
                StatusCode::UNAUTHORIZED
            );
            for retired in [
                "/api/rooms",
                "/api/pair",
                "/api/auth/login/challenge",
                "/ws",
            ] {
                assert_eq!(
                    request(&app, "POST", &route(retired), "", json!({}))
                        .await
                        .status(),
                    StatusCode::NOT_FOUND
                );
            }
            let mut tokens = Vec::new();
            for (device, account) in [
                ("desktop", "account-a"),
                ("mobile", "account-a"),
                ("outsider", "account-b"),
            ] {
                let response = request(&app, "POST", &route("/api/auth/login"), "", json!({
                "access_token":if email { account.replace("account", "email") } else { account.into() }, "user_id":"untrusted", "device_id":device,
                "device_name":device, "device_kind":"desktop", "public_key":BASE64.encode([9u8;32]),
                "request_id":uuid::Uuid::new_v4().to_string()
            })).await;
                assert_eq!(response.status(), StatusCode::OK);
                let response = json_body(response).await;
                assert_eq!(
                    response["user_id"],
                    if email {
                        if account == "account-a" {
                            "email-123"
                        } else {
                            "email-456"
                        }
                    } else if account == "account-a" {
                        "123"
                    } else {
                        "456"
                    }
                );
                tokens.push(response["token"].as_str().unwrap().to_owned());
            }
            for retired in ["/api/devices/desktop/rpc", "/api/devices/mobile/messages"] {
                assert_eq!(
                    request(&app, "POST", &route(retired), &tokens[1], json!({}))
                        .await
                        .status(),
                    StatusCode::NOT_FOUND
                );
            }
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server_app = app.clone();
            let server = tokio::spawn(async move {
                axum::serve(listener, server_app).await.unwrap();
            });
            // The host and controller report the same client protocol so the
            // control pair is compatible under the strict "matching builds only"
            // rule; the outsider stays legacy and is only used to prove
            // rejection.
            let mut socket = connect_scope_with_build(
                address,
                prefix,
                &tokens[0],
                "machine-scoped",
                Some(("1.0.0", 1)),
            )
            .await;
            event(
                &mut socket,
                1,
                "rpc-register",
                json!({"method":"desktop:remote-command"}),
            )
            .await;
            assert_eq!(acknowledgement(&mut socket, 1).await["ok"], true);
            let mut controller = connect_scope_with_build(
                address,
                prefix,
                &tokens[1],
                "user-scoped",
                Some(("1.0.0", 1)),
            )
            .await;
            let mut outsider = connect_scope(address, prefix, &tokens[2], "user-scoped").await;
            assert_eq!(
                request(
                    &app,
                    "PATCH",
                    &route("/api/devices/desktop"),
                    &tokens[0],
                    json!({"device_alias":"Build host"})
                )
                .await
                .status(),
                StatusCode::NO_CONTENT
            );
            assert_eq!(
                request(
                    &app,
                    "PATCH",
                    &route("/api/devices/desktop"),
                    &tokens[0],
                    json!({"device_model":"Model", "device_os":"Linux", "device_os_version":"6"})
                )
                .await
                .status(),
                StatusCode::NO_CONTENT
            );
            loop {
                let frame = packet(&mut controller).await;
                if let Some(payload) = frame.strip_prefix("42") {
                    let event: Value = serde_json::from_str(payload).unwrap();
                    if event[0] == "ephemeral" && event[1]["type"] == "device-presence" {
                        if event[1]["devices"].as_array().unwrap().iter().any(|row| {
                            row["device_alias"] == "Build host"
                                && row["device_model"] == "Model"
                                && row["device_os_version"] == "6"
                        }) {
                            break;
                        }
                    }
                }
            }
            let info =
                json_body(request(&app, "GET", &route("/api/info"), "", json!(null)).await).await;
            assert_eq!(info["protocol_version"], 3);
            assert_eq!(
                info["capabilities"],
                json!([
                    "device_alias_v1",
                    "device_metadata_v1",
                    "device_client_build_v1",
                    "device_kind_cli_v1"
                ])
            );
            let devices = json_body(
                request(&app, "GET", &route("/api/devices"), &tokens[1], json!(null)).await,
            )
            .await;
            assert!(devices
                .as_array()
                .unwrap()
                .iter()
                .any(|device| device["device_id"] == "desktop" && device["online"] == true));
            assert!(!devices
                .as_array()
                .unwrap()
                .iter()
                .any(|device| device["device_id"] == "outsider"));
            assert_eq!(
                request(
                    &app,
                    "GET",
                    &route("/api/devices/desktop/key"),
                    &tokens[1],
                    json!(null)
                )
                .await
                .status(),
                StatusCode::OK
            );
            assert_eq!(
                request(
                    &app,
                    "GET",
                    &route("/api/devices/desktop/key"),
                    &tokens[2],
                    json!(null)
                )
                .await
                .status(),
                StatusCode::NOT_FOUND
            );
            event(&mut outsider,2,"rpc-call",json!({"method":"desktop:remote-command","params":{"encryptedData":"YQ=="},"timeoutMs":200})).await;
            assert_eq!(
                acknowledgement(&mut outsider, 2).await["ok"],
                false,
                "cross-account RPC must not reach the host"
            );
            event(&mut controller,3,"rpc-call",json!({"method":"desktop:remote-command","params":{"encryptedData":"YQ==","nonce":"bg=="},"timeoutMs":3000})).await;
            let (ack_id, incoming) = loop {
                let message = packet(&mut socket).await;
                if let Some(rest) = message.strip_prefix("42") {
                    let index = rest.find('[').unwrap();
                    let data: Value = serde_json::from_str(&rest[index..]).unwrap();
                    if data[0] == "rpc-request" {
                        break (rest[..index].to_string(), data[1].clone());
                    }
                }
            };
            assert_eq!(incoming["sourceDeviceId"], "mobile");
            assert_eq!(incoming["params"]["encryptedData"], "YQ==");
            // ACK identity belongs to the target socket. A same-account caller
            // or another account cannot spoof the target's response correlation.
            let forged = format!("43{ack_id}{}", json!([{"forged":true}]));
            outsider
                .send(Message::Text(forged.clone().into()))
                .await
                .unwrap();
            controller.send(Message::Text(forged.into())).await.unwrap();
            assert!(tokio::time::timeout(
                Duration::from_millis(50),
                acknowledgement(&mut controller, 3)
            )
            .await
            .is_err());
            let payload = BASE64.encode(vec![7u8; 32 * 1024]);
            socket
                .send(Message::Text(
                    format!(
                        "43{ack_id}{}",
                        json!([{ "encryptedData":payload,"nonce":"bg=="}])
                    )
                    .into(),
                ))
                .await
                .unwrap();
            let response = acknowledgement(&mut controller, 3).await;
            assert_eq!(response["ok"], true);
            assert_eq!(response["result"]["encryptedData"], payload);
            assert_eq!(
                request(
                    &app,
                    "DELETE",
                    &route("/api/devices/desktop"),
                    &tokens[1],
                    json!(null)
                )
                .await
                .status(),
                StatusCode::NO_CONTENT
            );
            loop {
                let update = packet(&mut controller).await;
                if let Some(data) = update.strip_prefix("42") {
                    let value: Value = serde_json::from_str(data).unwrap();
                    if value[0] == "ephemeral"
                        && value[1]["type"] == "device-presence"
                        && !value[1]["devices"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .any(|entry| entry["device_id"] == "desktop")
                    {
                        break;
                    }
                }
            }
            assert_eq!(
                packet(&mut socket).await,
                "41",
                "device removal disconnects its active namespace"
            );
            assert_eq!(
                request(
                    &app,
                    "POST",
                    &route("/api/auth/logout"),
                    &tokens[1],
                    json!({})
                )
                .await
                .status(),
                StatusCode::NO_CONTENT
            );
            assert_eq!(
                request(&app, "GET", &route("/api/devices"), &tokens[1], json!(null))
                    .await
                    .status(),
                StatusCode::UNAUTHORIZED
            );
            // Revocation applies to already-open namespaces, not only future HTTP
            // requests. The server's authorization monitor disconnects idle peers.
            loop {
                let revoked = packet(&mut controller).await;
                if revoked == "41" {
                    break;
                }
                assert!(
                    revoked.starts_with("42"),
                    "unexpected packet after revocation"
                );
            }
            outsider.close(None).await.unwrap();
            let _ = socket.close(None).await;
            server.abort();
        }
    }
    authority_task.abort();
}

/// Two same-account desktop-kind devices, each with its own full device token.
struct BuildFixture {
    app: Router,
    db: Arc<db::DbPool>,
    desktop_token: String,
    mobile_token: String,
    outsider_token: String,
}

async fn client_build_fixture() -> BuildFixture {
    let db = Arc::new(db::connect(":memory:").await.unwrap());
    db::UserRow::create(&db, "owner", "alice").await.unwrap();
    db::UserRow::create(&db, "outsider", "bob").await.unwrap();
    for (device, account) in [
        ("desktop", "owner"),
        ("mobile", "owner"),
        ("outsider", "outsider"),
    ] {
        db::DeviceRow::upsert(&db, device, account, device, Some("desktop"), None)
            .await
            .unwrap();
    }
    let desktop_token = db::AuthToken::create(&db, "owner", "desktop")
        .await
        .unwrap()
        .token;
    let mobile_token = db::AuthToken::create(&db, "owner", "mobile")
        .await
        .unwrap()
        .token;
    let outsider_token = db::AuthToken::create(&db, "outsider", "outsider")
        .await
        .unwrap()
        .token;
    let app = build_relay_router(
        Arc::new(MemoryAssetStore::new()),
        Instant::now(),
        db.clone(),
        "test",
    );
    BuildFixture {
        app,
        db,
        desktop_token,
        mobile_token,
        outsider_token,
    }
}

async fn spawn(app: Router) -> (std::net::SocketAddr, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let handle = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (address, handle)
}

async fn next_forwarded_rpc_request(socket: &mut Socket) -> (String, Value) {
    loop {
        let message = packet(socket).await;
        if let Some(rest) = message.strip_prefix("42") {
            let index = rest.find('[').unwrap();
            let data: Value = serde_json::from_str(&rest[index..]).unwrap();
            if data[0] == "rpc-request" {
                return (rest[..index].to_string(), data[1].clone());
            }
        }
    }
}

#[tokio::test]
async fn rpc_call_is_rejected_for_incompatible_client_builds() {
    let fixture = client_build_fixture().await;
    let (address, server) = spawn(fixture.app.clone()).await;

    let mut desktop = connect_scope_with_build(
        address,
        "",
        &fixture.desktop_token,
        "machine-scoped",
        Some(("2.0.0", 3)),
    )
    .await;
    event(
        &mut desktop,
        1,
        "rpc-register",
        json!({"method":"desktop:remote-command"}),
    )
    .await;
    assert_eq!(acknowledgement(&mut desktop, 1).await["ok"], true);

    // A controller reporting a different protocol is refused before dispatch.
    let mut mismatched = connect_scope_with_build(
        address,
        "",
        &fixture.mobile_token,
        "user-scoped",
        Some(("1.0.0", 4)),
    )
    .await;
    event(&mut mismatched,2,"rpc-call",json!({"method":"desktop:remote-command","params":{"encryptedData":"YQ=="},"timeoutMs":1000})).await;
    let ack = acknowledgement(&mut mismatched, 2).await;
    assert_eq!(ack["ok"], false);
    assert_eq!(
        ack["error"],
        "incompatible client build: remote control requires matching client versions"
    );
    assert!(
        forwarded_no_rpc_request(&mut desktop, Duration::from_millis(400)).await,
        "an incompatible call must never be dispatched"
    );

    // A legacy controller that reports no protocol at all is also refused: a
    // missing build cannot be proven compatible.
    let mut legacy = connect_scope(address, "", &fixture.mobile_token, "user-scoped").await;
    event(&mut legacy,4,"rpc-call",json!({"method":"desktop:remote-command","params":{"encryptedData":"YQ=="},"timeoutMs":500})).await;
    let ack = acknowledgement(&mut legacy, 4).await;
    assert_eq!(ack["ok"], false);
    assert_eq!(
        ack["error"],
        "incompatible client build: remote control requires matching client versions"
    );
    assert!(forwarded_no_rpc_request(&mut desktop, Duration::from_millis(300)).await);

    // A controller reporting the same protocol is forwarded as before.
    let mut matched = connect_scope_with_build(
        address,
        "",
        &fixture.mobile_token,
        "user-scoped",
        Some(("2.0.0", 3)),
    )
    .await;
    event(&mut matched,3,"rpc-call",json!({"method":"desktop:remote-command","params":{"encryptedData":"YQ=="},"timeoutMs":3000})).await;
    let (ack_id, incoming) = next_forwarded_rpc_request(&mut desktop).await;
    assert_eq!(incoming["sourceDeviceId"], "mobile");
    desktop
        .send(Message::Text(
            format!("43{ack_id}{}", json!([{"encryptedData":"Zg=="}])).into(),
        ))
        .await
        .unwrap();
    let response = acknowledgement(&mut matched, 3).await;
    assert_eq!(response["ok"], true);

    server.abort();
}

#[tokio::test]
async fn rpc_call_stays_account_scoped_with_matching_builds() {
    let fixture = client_build_fixture().await;
    let (address, server) = spawn(fixture.app.clone()).await;

    let mut desktop = connect_scope_with_build(
        address,
        "",
        &fixture.desktop_token,
        "machine-scoped",
        Some(("2.0.0", 3)),
    )
    .await;
    event(
        &mut desktop,
        1,
        "rpc-register",
        json!({"method":"desktop:remote-command"}),
    )
    .await;
    assert_eq!(acknowledgement(&mut desktop, 1).await["ok"], true);

    // Matching builds do not bypass account scoping: the room is per account.
    let mut outsider = connect_scope_with_build(
        address,
        "",
        &fixture.outsider_token,
        "user-scoped",
        Some(("2.0.0", 3)),
    )
    .await;
    event(&mut outsider,2,"rpc-call",json!({"method":"desktop:remote-command","params":{"encryptedData":"YQ=="},"timeoutMs":300})).await;
    assert_eq!(acknowledgement(&mut outsider, 2).await["ok"], false);
    assert!(forwarded_no_rpc_request(&mut desktop, Duration::from_millis(200)).await);

    // A legacy outsider (no reported build) is likewise rejected and still
    // cannot reach the other account's target.
    let mut legacy_outsider =
        connect_scope(address, "", &fixture.outsider_token, "user-scoped").await;
    event(&mut legacy_outsider,3,"rpc-call",json!({"method":"desktop:remote-command","params":{"encryptedData":"YQ=="},"timeoutMs":300})).await;
    assert_eq!(acknowledgement(&mut legacy_outsider, 3).await["ok"], false);
    assert!(forwarded_no_rpc_request(&mut desktop, Duration::from_millis(200)).await);

    server.abort();
}

#[tokio::test]
async fn rpc_call_is_rejected_for_two_legacy_clients() {
    let fixture = client_build_fixture().await;
    let (address, server) = spawn(fixture.app.clone()).await;

    // Neither end reports a protocol. A matching build cannot be proven, so the
    // pair is incompatible and the call is refused instead of dispatched.
    let mut desktop = connect_scope(address, "", &fixture.desktop_token, "machine-scoped").await;
    event(
        &mut desktop,
        1,
        "rpc-register",
        json!({"method":"desktop:remote-command"}),
    )
    .await;
    assert_eq!(acknowledgement(&mut desktop, 1).await["ok"], true);

    let mut controller = connect_scope(address, "", &fixture.mobile_token, "user-scoped").await;
    event(&mut controller,2,"rpc-call",json!({"method":"desktop:remote-command","params":{"encryptedData":"YQ=="},"timeoutMs":500})).await;
    let ack = acknowledgement(&mut controller, 2).await;
    assert_eq!(ack["ok"], false);
    assert_eq!(
        ack["error"],
        "incompatible client build: remote control requires matching client versions"
    );
    assert!(forwarded_no_rpc_request(&mut desktop, Duration::from_millis(300)).await);

    server.abort();
}

#[tokio::test]
async fn handshake_records_and_clears_the_client_build() {
    let fixture = client_build_fixture().await;
    let (address, server) = spawn(fixture.app.clone()).await;

    let mut socket = connect_scope_with_build(
        address,
        "",
        &fixture.desktop_token,
        "machine-scoped",
        Some(("2.0.0", 9)),
    )
    .await;
    let row = db::DeviceRow::list_by_user(&fixture.db, "owner")
        .await
        .unwrap()
        .into_iter()
        .find(|row| row.device_id == "desktop")
        .unwrap();
    assert_eq!(row.client_version.as_deref(), Some("2.0.0"));
    assert_eq!(row.client_protocol_u32(), Some(9));
    socket.close(None).await.unwrap();
    let _ = socket.close(None).await;

    // A reconnect that reports nothing clears both values instead of keeping
    // the previous, now-stale build.
    let mut socket = connect_scope(address, "", &fixture.desktop_token, "machine-scoped").await;
    let row = db::DeviceRow::list_by_user(&fixture.db, "owner")
        .await
        .unwrap()
        .into_iter()
        .find(|row| row.device_id == "desktop")
        .unwrap();
    assert!(row.client_version.is_none());
    assert!(row.client_protocol.is_none());
    let _ = socket.close(None).await;

    server.abort();
}
